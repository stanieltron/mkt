"use strict";

const { runRandom10000TrendModelV3 } = require("./scenario-core");

runRandom10000TrendModelV3({
  regime: "uptrend",
  title: "Model V3: Uptrend 10000 Trades (Target ~2x)",
  priceSeed: "v3-uptrend-price",
  tradeSeed: "v3-uptrend-trades",
});
