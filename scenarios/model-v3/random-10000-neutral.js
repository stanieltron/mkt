"use strict";

const { runRandom10000TrendModelV3 } = require("./scenario-core");

runRandom10000TrendModelV3({
  regime: "neutral",
  title: "Model V3: Neutral 10000 Trades",
  priceSeed: "v3-neutral-price",
  tradeSeed: "v3-neutral-trades",
});
