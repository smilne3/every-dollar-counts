// The two series colours of the validated pair (spec §5.1) — the emerald every chart leads with,
// and the colour a comparison's prior window is drawn in. SpendIncomeChart's coral is a third
// series and stays inline deliberately: it was not part of the pair that was measured together,
// so folding it in here would imply a validation it has not had.
//
// `comparison` was #c9cec7 until spec §5.1. That grey measured 1.56:1 against the surface and failed
// two palette checks — a series you cannot see is not a comparison. #0369a1 against the existing
// #0e9f6e passes all six checks in light mode and holds in dark mode with a single 2.94:1 warning,
// which the direct amount labels discharge.
//
// Not phone-only, deliberately: a contrast failure is not a mobile defect, it is a defect mobile
// made obvious. Applying it below `md` alone would leave the desktop chart failing the same check
// for no reason.
//
// Here rather than inline in each chart so the §9 test has one thing to pin — three copies of a
// hex literal is three places a future change can half-happen.
export const CHART_SERIES = {
  // The brand emerald. The only series in SpendByCategoryChart, the income series in
  // SpendIncomeChart, and the CURRENT window wherever two windows are compared.
  primary: '#0e9f6e',
  // The PRIOR window. Named for its role rather than its colour so a future palette change does
  // not leave three call sites reading `CHART_SERIES.blue`.
  comparison: '#0369a1',
} as const
