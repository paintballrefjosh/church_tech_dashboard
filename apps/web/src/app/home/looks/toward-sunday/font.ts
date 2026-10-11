import { Archivo } from "next/font/google";

/** Archivo with its width axis: the headline runs wide, the countdown and day numbers condensed. */
export const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  display: "swap",
  variable: "--font-toward-sunday",
});
