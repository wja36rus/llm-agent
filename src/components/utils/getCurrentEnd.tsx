export const getCurrentEnd = (text: string) => {
  return typeof text === "string" && text.length ? text[text.length - 1] : "";
};
