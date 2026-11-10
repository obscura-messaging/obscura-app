// claude: Nunito, the board's face, as four fixed weights in assets/fonts. Each weight is its own family because
// Android picks custom fonts by name, not by fontWeight; the names are the fonts' PostScript names, which iOS uses.
export const FONT = {
  600: 'Nunito-SemiBold',
  700: 'Nunito-Bold',
  800: 'Nunito-ExtraBold',
  900: 'Nunito-Black',
} as const;
