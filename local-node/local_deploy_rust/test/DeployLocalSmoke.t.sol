pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {Makeit} from "solidity/src/Makeit.sol";
import {MockERC20} from "./helpers/MockERC20.sol";
import {MockWETH} from "./helpers/MockWETH.sol";
import {MakeitProxy} from "./helpers/MakeitProxy.sol";
import {MockPriceOracle} from "./helpers/MockPriceOracle.sol";
import {MockSwapAdapter} from "./helpers/MockSwapAdapter.sol";

contract DeployLocalSmokeTest is Test {
    address internal trader = address(0xA11CE);

    MockERC20 internal usdc;
    MockWETH internal weth;
    MockPriceOracle internal oracle;
    MockSwapAdapter internal adapter;
    Makeit internal implementation;
    Makeit internal makeit;

    function setUp() public {
        vm.deal(address(this), 1_000_000e18);
        usdc = new MockERC20("Mock USD Coin", "mUSDC", 6);
        weth = new MockWETH();
        oracle = new MockPriceOracle(3_000e18);
        adapter = new MockSwapAdapter(address(usdc), address(weth), address(oracle));
        implementation = new Makeit();
        makeit = Makeit(
            payable(
                address(
                    new MakeitProxy(
                        address(implementation),
                        abi.encodeCall(Makeit.initialize, (address(usdc), address(weth), address(this)))
                    )
                )
            )
        );

        makeit.setOracle(address(oracle));
        makeit.setExternalDex(address(adapter));

        weth.mint{value: 100e18}(address(this), 100e18);
        weth.approve(address(makeit), type(uint256).max);
        makeit.configureLpProvision(address(this), true, type(uint256).max);
        makeit.deposit(100e18, address(this));

        usdc.mint(address(this), 500_000e6);
        usdc.approve(address(makeit), type(uint256).max);

        weth.mint{value: 100e18}(address(adapter), 100e18);
        usdc.mint(address(adapter), 500_000e6);

        usdc.mint(trader, 1_000_000e6);
        vm.prank(trader);
        usdc.approve(address(makeit), type(uint256).max);
    }

    function testLocalProxyDeploysAndOpensTrade() public {
        // expectedPrice=3000e18, toleranceBps=100, profitTargetPpm=1_000, leverage=10, margin=10_000e6
        vm.prank(trader);
        uint256 tradeId = makeit.openLongTrade(3_000e18, 100, 1_000, 10, 10_000e6);

        Makeit.Trade memory trade = makeit.getTrade(tradeId);

        assertEq(tradeId, 1);
        assertEq(trade.trader, trader);
        assertEq(uint256(trade.side), uint256(Makeit.Side.LONG));
        assertEq(uint256(trade.status), uint256(Makeit.Status.OPEN));
        assertEq(makeit.nextTradeId(), 2);
        assertGt(makeit.openLongNotionalUSDC(), 0);
    }
}
