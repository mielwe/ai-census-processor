# AI-Powered Census Data Processor

## 🌟 Overview
A production-ready React application that automates data extraction from complex medical census PDF reports using **Google Gemini 1.5 Flash**. 

## 🛠 Tech Stack
- **Frontend:** React, TypeScript, Tailwind CSS
- **AI Integration:** Google Generative AI (Gemini API)
- **Data Handling:** XLSX (for Excel generation), Lucide-React
- **Animations:** Framer Motion

## 🎯 Key Engineering Features
- **Deterministic Validation:** The AI is instructed to perform a self-check by summing daily entries and comparing them with the "PDF Total" to ensure 100% data integrity.
- **Robust Error Handling:** Implements exponential backoff for API rate limits (429 errors) and handles various PDF formats dynamically.
- **Type Safety:** Fully typed with TypeScript to prevent runtime errors during data transformation.

## 🚀 How to Run
1. Clone the repo.
2. Run `npm install`.
3. Create a `.env` file with your `GEMINI_API_KEY`.
4. Run `npm run dev`.
