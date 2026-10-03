import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f5f7ff",
          100: "#e9ecfb",
          200: "#ccd4f6",
          300: "#a7b0ec",
          400: "#818de1",
          500: "#5b6bd6",
          600: "#4554c1",
          700: "#3741a5",
          800: "#2f3888",
          900: "#27306a",
          950: "#171b3c",
        },
      },
    },
  },
  plugins: [typography],
} satisfies Config;
