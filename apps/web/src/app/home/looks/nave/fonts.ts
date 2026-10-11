import { Karla, Marcellus } from "next/font/google";

export const marcellus = Marcellus({
  weight: "400",
  subsets: ["latin"],
  display: "swap",
  variable: "--nave-serif",
});

export const karla = Karla({
  subsets: ["latin"],
  display: "swap",
  variable: "--nave-sans",
});
