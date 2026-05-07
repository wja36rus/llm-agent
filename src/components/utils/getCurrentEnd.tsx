export const getCurrentEnd = (text: string | any) => {
  return typeof text !== "string"
    ? text
    : text.length
      ? text[text.length - 1]
      : text;
};
