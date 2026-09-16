/** @type {import('tailwindcss').Config} */
module.exports = {
  // NativeWind's web stylesheet observer requires class-based color schemes.
  darkMode: "class",
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./src/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        background: "#FAF8F3",
        surface: "#FFFFFF",
        "surface-muted": "#F2EFE8",
        foreground: "#1D1C1A",
        "muted-foreground": "#68645E",
        border: "#DDD8CF",
        primary: "#315C4D",
        "primary-foreground": "#FFFFFF",
        "primary-soft": "#E4ECE8",
        "primary-soft-strong": "#D2E0DA",
        destructive: "#B53B32",
        "destructive-foreground": "#FFFFFF",
        "destructive-soft": "#F6E4E1",
        focus: "#1B6C9C",
      },
      spacing: {
        xs: "4px",
        sm: "8px",
        md: "16px",
        lg: "24px",
        xl: "32px",
      },
      borderRadius: {
        md: "12px",
        lg: "18px",
      },
      fontSize: {
        eyebrow: ["16px", { lineHeight: "24px" }],
        body: ["16px", { lineHeight: "24px" }],
        caption: ["15px", { lineHeight: "22px" }],
        title: ["32px", { lineHeight: "38px" }],
        hero: ["72px", { lineHeight: "80px" }],
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
