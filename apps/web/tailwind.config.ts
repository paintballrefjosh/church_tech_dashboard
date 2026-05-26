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
          500: "#5b6bd6",
          600: "#4554c1",
          700: "#3741a5",
        },
      },
    },
  },
  plugins: [typography],
} satisfies Config;
