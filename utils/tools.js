export const writeStatus = (res, type, text = "") => {
  res.write(`\n[S:${type}:${text}]`);
};
