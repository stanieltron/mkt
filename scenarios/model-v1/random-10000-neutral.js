"use strict";

const { runRandom10000TrendModelV1 } = require("./scenario-core");

runRandom10000TrendModelV1({
  regime: "neutral",
  title: "Model V1: Neutral 10000 Trades",
  priceSeed: "v1-neutral-price",
  tradeSeed: "v1-neutral-trades",
});

