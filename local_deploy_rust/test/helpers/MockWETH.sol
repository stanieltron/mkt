pragma solidity ^0.8.20;

import {MockERC20} from "./MockERC20.sol";

contract MockWETH is MockERC20("Mock Wrapped Ether", "mWETH", 18) {
    event Deposit(address indexed from, address indexed to, uint256 amount);
    event Withdrawal(address indexed from, address indexed to, uint256 amount);

    error EthTransferFailed();
    error InvalidMintValue(uint256 expected, uint256 provided);

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        _mint(msg.sender, msg.value);
        emit Deposit(msg.sender, msg.sender, msg.value);
    }

    function mint(address to, uint256 amount) external payable override {
        if (msg.value != amount) revert InvalidMintValue(amount, msg.value);
        _mint(to, amount);
        emit Deposit(msg.sender, to, amount);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
        emit Withdrawal(msg.sender, msg.sender, amount);
    }
}
