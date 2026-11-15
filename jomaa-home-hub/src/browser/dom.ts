export function isFocused(element: { matches(selector: string): boolean }): boolean {
  return element.matches(":focus");
}
