export const getCurrentEnd = (text: string | any) => {
  return typeof text !== "string" ? text : text[text.length - 1];
};
