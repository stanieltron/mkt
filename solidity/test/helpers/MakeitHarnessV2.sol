pragma solidity ^0.8.20;

import {Makeit} from "../../src/Makeit.sol";

contract MakeitHarnessV2 is Makeit {
    uint256 public upgradeMarker;

    function setUpgradeMarker(uint256 newMarker) external {
        upgradeMarker = newMarker;
    }
}
