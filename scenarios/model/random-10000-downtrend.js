"use strict";

const { runRandom10000TrendModelV4 } = require("./scenario-core");

runRandom10000TrendModelV4({
  regime: "downtrend",
  title: "Model V4: Downtrend 10000 Trades (Long+Short Offset)",
  priceSeed: "v4-downtrend-price",
  tradeSeed: "v4-downtrend-trades",
});
