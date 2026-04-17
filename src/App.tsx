/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import * as XLSX from 'xlsx';
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import { FileText, Download, Loader2, CheckCircle2, AlertCircle, UploadCloud } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { FACILITIES } from './constants';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface DailyCensus {
  day: number;
  census: number;
}

interface FacilityData {
  facility: string;
  month: string;
  year: number;
  dailyData: DailyCensus[];
  pdfTotal?: number; // The total provided in the PDF for validation
}

export default function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentFileIndex, setCurrentFileIndex] = useState<number>(-1);
  const [extractedData, setExtractedData] = useState<FacilityData[]>([]);
  const [error, setError] = useState<string | null>(null);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    setFiles(acceptedFiles);
    setError(null);
    setExtractedData([]);
    setCurrentFileIndex(-1);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/pdf': ['.pdf']
    },
    multiple: true
  } as any);

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const base64String = (reader.result as string).split(',')[1];
        resolve(base64String);
      };
      reader.onerror = (error) => reject(error);
    });
  };

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const processFiles = async () => {
    if (files.length === 0) return;

    setIsProcessing(true);
    setError(null);
    setExtractedData([]);
    const allExtracted: FacilityData[] = [];

    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("GEMINI_API_KEY is missing. Please check your .env file.");
      }

      const ai = new GoogleGenAI({ apiKey });

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setCurrentFileIndex(i);
        const base64Data = await fileToBase64(file);
        
        let retryCount = 0;
        const maxRetries = 3;
        let success = false;

        while (!success && retryCount <= maxRetries) {
          try {
            const response = await ai.models.generateContent({
              model: "gemini-3-flash-preview",
              contents: [
                {
                  parts: [
                    {
                      inlineData: {
                        mimeType: "application/pdf",
                        data: base64Data
                      }
                    },
                    {
                      text: `Analyze this PDF census report with EXTREME PRECISION. 
The data you extract will be used for financial records, so there is ZERO tolerance for misreading numbers.

It might be in one of several formats:
1. "Monthly Census - Ending [Month] [Year]" (e.g., Humboldt House): 
   - Extract the "Total Residents" row for each day (columns 1 to 31).
   - Use the "Total" value for "Total Residents" as the pdfTotal.
2. "Daily Census for Period [Start] - [End]" (e.g., AristaCare):
   - Extract the "TOTAL" column under the "Census" section for each date.
   - Use the "Census:" total from the "Totals" page as the pdfTotal.
3. "Detailed Census Report - By Payer" (e.g., Ahoskie, Richmond, Iliff):
   - Extract the "PAID DAYS" row for each day.
   - Use the "PAID DAYS" grand total (usually found on the left side of the row or at the bottom) as the pdfTotal.

CRITICAL VERIFICATION RULE:
Before finalizing your response, you MUST sum the daily values you extracted for each facility.
If your calculated sum does NOT match the 'pdfTotal' you found in the document, you have misread a number. 
Re-examine the grid carefully. Look for common OCR errors (e.g., misreading 3 as 8, 5 as 6, 0 as 8, or 23 as 25).
The grid is very dense; ensure your eyes stay on the correct row for every single day.

For each facility found in the report:
1. Identify the EXACT Facility Name.
2. Identify the Month and Year.
3. Extract the daily values based on the format rules above.
4. Extract the Grand Total provided in the PDF for validation.

Match the extracted facility name against this list of valid facility names:
${FACILITIES.join(", ")}

Return the data as a JSON array of objects.
Important: Only return the JSON array, no other text.
Schema:
[
  {
    "facility": "Matched Facility Name",
    "month": "January",
    "year": 2026,
    "dailyData": [
      {"day": 1, "census": 120},
      {"day": 2, "census": 121}
    ],
    "pdfTotal": 3826
  }
]`
                    }
                  ]
                }
              ],
              config: {
                thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
                responseMimeType: "application/json",
                responseSchema: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      facility: { type: Type.STRING },
                      month: { type: Type.STRING },
                      year: { type: Type.NUMBER },
                      dailyData: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            day: { type: Type.NUMBER },
                            census: { type: Type.NUMBER }
                          },
                          required: ["day", "census"]
                        }
                      },
                      pdfTotal: { type: Type.NUMBER }
                    },
                    required: ["facility", "month", "year", "dailyData", "pdfTotal"]
                  }
                }
              }
            });

            if (!response.text) {
              throw new Error("The model returned an empty response.");
            }

            const result = JSON.parse(response.text);
            allExtracted.push(...result);
            success = true;
          } catch (err: any) {
            const errorMsg = err.message || "";
            const isRetryable = errorMsg.includes("503") || errorMsg.includes("429") || errorMsg.toLowerCase().includes("quota") || errorMsg.toLowerCase().includes("demand");
            
            if (isRetryable && retryCount < maxRetries) {
              retryCount++;
              const waitTime = Math.pow(2, retryCount) * 5000; // Exponential backoff: 10s, 20s, 40s
              console.warn(`Attempt ${retryCount} failed for ${file.name}. Retrying in ${waitTime/1000}s...`, err);
              await sleep(waitTime);
            } else {
              throw err;
            }
          }
        }
        
        // Delay between files to avoid hitting rate limits on free keys
        if (i < files.length - 1) {
          await sleep(5000); // 5 second delay between successful files
        }
      }

      setExtractedData(allExtracted);
      setCurrentFileIndex(-1);
    } catch (err: any) {
      console.error(err);
      let userMessage = err.message || "An unexpected error occurred.";
      
      if (userMessage.includes("429") || userMessage.toLowerCase().includes("quota")) {
        userMessage = "API Limit Reached (Free Tier). Please wait 60 seconds and try again with fewer files.";
      } else if (userMessage.includes("503") || userMessage.toLowerCase().includes("demand")) {
        userMessage = "The AI service is currently overloaded (503). Please try again in a few minutes or process files one by one.";
      } else if (userMessage.includes("500")) {
        userMessage = "Gemini Server Error. Please try again in a moment.";
      }
      
      setError(userMessage);
    } finally {
      setIsProcessing(false);
    }
  };

  const downloadExcel = () => {
    if (extractedData.length === 0) return;

    const monthMap: { [key: string]: string } = {
      'January': '01', 'February': '02', 'March': '03', 'April': '04',
      'May': '05', 'June': '06', 'July': '07', 'August': '08',
      'September': '09', 'October': '10', 'November': '11', 'December': '12'
    };

    const rows = extractedData.flatMap(facility => {
      const monthNum = monthMap[facility.month] || '01';
      return facility.dailyData.map(dayData => ({
        Date: `${monthNum}/${dayData.day.toString().padStart(2, '0')}/${facility.year}`,
        Census: dayData.census,
        Facility: facility.facility
      }));
    });

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Census Data");
    XLSX.writeFile(workbook, `Census_Data_${new Date().getTime()}.xlsx`);
  };

  const calculateSum = (data: DailyCensus[]) => {
    return data.reduce((acc, curr) => acc + curr.census, 0);
  };

  return (
    <div className="min-h-screen bg-[#F8F9FA] text-[#1A1A1A] font-sans p-6 md:p-12">
      <div className="max-w-5xl mx-auto">
        <header className="mb-12">
          <h1 className="text-4xl font-bold tracking-tight mb-2">Census PDF to Excel</h1>
          <p className="text-[#6C757D] text-lg">
            Upload your Monthly Census reports to extract Paid Days data. Supports multiple formats.
          </p>
        </header>

        <main className="space-y-8">
          {/* Upload Section */}
          <section
            {...getRootProps()}
            className={cn(
              "border-2 border-dashed rounded-2xl p-12 transition-all cursor-pointer flex flex-col items-center justify-center text-center",
              isDragActive ? "border-[#007BFF] bg-[#E7F1FF]" : "border-[#DEE2E6] bg-white hover:border-[#ADB5BD]"
            )}
          >
            <input {...getInputProps()} />
            <div className="w-16 h-16 bg-[#F1F3F5] rounded-full flex items-center justify-center mb-4">
              <UploadCloud className="w-8 h-8 text-[#495057]" />
            </div>
            <h3 className="text-xl font-semibold mb-1">
              {files.length > 0 ? `${files.length} file(s) selected` : "Drop PDF files here"}
            </h3>
            <p className="text-[#6C757D]">or click to browse your computer</p>
          </section>

          {/* Action Buttons */}
          <div className="flex flex-wrap gap-4">
            <button
              onClick={processFiles}
              disabled={files.length === 0 || isProcessing}
              className={cn(
                "px-8 py-3 rounded-xl font-semibold transition-all flex items-center gap-2",
                files.length === 0 || isProcessing
                  ? "bg-[#E9ECEF] text-[#ADB5BD] cursor-not-allowed"
                  : "bg-[#1A1A1A] text-white hover:bg-[#333333] active:scale-95"
              )}
            >
              {isProcessing ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  <FileText className="w-5 h-5" />
                  Extract Data
                </>
              )}
            </button>

            {extractedData.length > 0 && (
              <button
                onClick={downloadExcel}
                className="px-8 py-3 bg-[#28A745] text-white rounded-xl font-semibold hover:bg-[#218838] transition-all flex items-center gap-2 active:scale-95"
              >
                <Download className="w-5 h-5" />
                Download Excel
              </button>
            )}
          </div>

          {/* Progress Indicator */}
          {isProcessing && (
            <div className="p-6 bg-[#E7F1FF] border border-[#007BFF] rounded-2xl flex flex-col items-center gap-4 shadow-sm">
              <Loader2 className="w-8 h-8 text-[#007BFF] animate-spin" />
              <div className="text-center">
                <p className="text-[#004085] font-bold">
                  Processing file {currentFileIndex + 1} of {files.length}
                </p>
                <p className="text-[#007BFF] text-sm mt-1 font-medium">
                  {files[currentFileIndex]?.name}
                </p>
              </div>
              <div className="w-full max-w-md bg-[#DEE2E6] rounded-full h-3 overflow-hidden">
                <div 
                  className="bg-[#007BFF] h-full transition-all duration-500 ease-out" 
                  style={{ width: `${((currentFileIndex + 1) / files.length) * 100}%` }}
                />
              </div>
              <p className="text-xs text-[#6C757D] italic">
                Analyzing with high precision. This may take a moment per file...
              </p>
            </div>
          )}

          {/* Error Message */}
          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="p-4 bg-[#FFF5F5] border border-[#FEB2B2] text-[#C53030] rounded-xl flex items-center gap-3"
              >
                <AlertCircle className="w-5 h-5 flex-shrink-0" />
                <p>{error}</p>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Results Preview */}
          {extractedData.length > 0 && (
            <motion.section
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="bg-white border border-[#DEE2E6] rounded-2xl overflow-hidden shadow-sm"
            >
              <div className="p-6 border-bottom border-[#DEE2E6] bg-[#F8F9FA] flex items-center justify-between">
                <h3 className="font-bold text-lg flex items-center gap-2">
                  <CheckCircle2 className="w-5 h-5 text-[#28A745]" />
                  Extraction Complete
                </h3>
                <span className="text-sm text-[#6C757D]">
                  {extractedData.length} facilities found
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-[#F1F3F5] text-[#495057] text-sm uppercase tracking-wider">
                      <th className="px-6 py-4 font-semibold">Facility</th>
                      <th className="px-6 py-4 font-semibold">Month</th>
                      <th className="px-6 py-4 font-semibold">Daily Sum</th>
                      <th className="px-6 py-4 font-semibold">PDF Total</th>
                      <th className="px-6 py-4 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#DEE2E6]">
                    {extractedData.map((item, idx) => {
                      const sum = calculateSum(item.dailyData);
                      const matches = item.pdfTotal === undefined || sum === item.pdfTotal;
                      return (
                        <tr key={idx} className="hover:bg-[#F8F9FA] transition-colors">
                          <td className="px-6 py-4 font-medium">{item.facility}</td>
                          <td className="px-6 py-4 text-[#6C757D]">{item.month} {item.year}</td>
                          <td className="px-6 py-4 font-mono">{sum}</td>
                          <td className="px-6 py-4 font-mono">{item.pdfTotal ?? "N/A"}</td>
                          <td className="px-6 py-4">
                            {matches ? (
                              <span className="px-3 py-1 bg-[#E1F9E6] text-[#1E7E34] rounded-full text-xs font-bold flex items-center gap-1 w-fit">
                                <CheckCircle2 className="w-3 h-3" /> Match
                              </span>
                            ) : (
                              <span className="px-3 py-1 bg-[#FFF5F5] text-[#C53030] rounded-full text-xs font-bold flex items-center gap-1 w-fit">
                                <AlertCircle className="w-3 h-3" /> Mismatch
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </motion.section>
          )}
        </main>

        <footer className="mt-20 pt-8 border-t border-[#DEE2E6] text-center text-[#ADB5BD] text-sm">
          <p>© 2026 Census Data Processor.</p>
        </footer>
      </div>
    </div>
  );
}