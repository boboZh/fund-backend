const { AsyncLocalStorage } = require("async_hooks");

const signalContext = new AsyncLocalStorage();

module.exports = {
  signalContext,
};
