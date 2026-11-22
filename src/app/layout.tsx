import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/theme-provider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "LocalForge IDE — Your models. Your machine. Your IDE.",
  description:
    "Browser-based AI coding IDE that connects to your own locally running language models (Ollama, LM Studio, llama.cpp, Lemonade). Files, agents and inference stay on your machine.",
  keywords: ["LocalForge", "AI IDE", "local AI", "Ollama", "LM Studio", "llama.cpp", "coding agent"],
  icons: {
    icon: "/logo.svg",
  },
  openGraph: {
    title: "LocalForge IDE",
    description: "Your models. Your machine. Your IDE.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem={false}
          disableTransitionOnChange
        >
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
