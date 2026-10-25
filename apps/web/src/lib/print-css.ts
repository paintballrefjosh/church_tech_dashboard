/**
 * Rules shared by the printable pages (cabinet sheet, port sheets). The page is A4 portrait with a modest margin; colours
 * and pictures are printed as drawn (browsers drop backgrounds unless asked), and the nav chrome is left out by the pages
 * themselves. A row of a table is never split across two pages and a table's heading repeats on each.
 */
export const PRINT_BASE_CSS = `
@page { size: A4 portrait; margin: 10mm; }
.print-sheet, .print-sheet * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.print-sheet thead { display: table-header-group; }
.print-sheet tr { break-inside: avoid; }
@media print {
  html, body { background: #fff !important; }
}
`;
