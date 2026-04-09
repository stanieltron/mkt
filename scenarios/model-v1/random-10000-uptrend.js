"use strict";

const { runRandom10000TrendModelV1 } = require("./scenario-core");

runRandom10000TrendModelV1({
  regime: "uptrend",
  title: "Model V1: Uptrend 10000 Trades (Target ~2x)",
  priceSeed: "v1-uptrend-price",
  tradeSeed: "v1-uptrend-trades",
});

