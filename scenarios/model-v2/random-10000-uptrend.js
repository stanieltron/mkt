"use strict";

const { runRandom10000TrendModelV2 } = require("./scenario-core");

runRandom10000TrendModelV2({
  regime: "uptrend",
  title: "Model V2: Uptrend 10000 Trades (Target ~2x)",
  priceSeed: "v2-uptrend-price",
  tradeSeed: "v2-uptrend-trades",
});
