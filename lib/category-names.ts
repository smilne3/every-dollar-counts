// Names a household's category can't have, because each already means something to the app and a
// category called it would be mistaken for that (#100, #117):
// - "Uncategorized": what a row shows when its bank's category maps to none of the household's
//   (bankCategory in lib/category-rules.ts). Picks of a real one would share its line in every total.
// - "Other": the phone Trends chart's bar for every category below its top six (capCategories in
//   lib/trends.ts), so there would be two bars of that name.
// - "None": Jev's answer when none of the categories fits (NONE in lib/category-suggest-request.ts).
//   suggestionOptions throws on a spending category of that name, which stops every Jev run.
// Matched in any case, as suggestionOptions matches "none".
const RESERVED = ['uncategorized', 'other', 'none']

// The words refusing `name` as a category's name, or null when it can be one. `name` comes trimmed,
// as the categories route trims it before saving.
//
// Also refused: a name every object already has, such as constructor, toString or __proto__. The
// per-category figures are kept in plain objects keyed by name, so a category called one would find
// what the object inherits instead of its own figure, and its spending would be summed as text or
// lost (#243). Matched exactly, as an object's keys are.
export function refusedCategoryName(name: string): string | null {
  if (RESERVED.includes(name.toLowerCase()) || name in Object.prototype) {
    return `“${name}” is a name the app uses. Choose another.`
  }
  return null
}
