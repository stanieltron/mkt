pragma solidity ^0.8.20;

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    error InvalidAddress();
    error InsufficientBalance(uint256 requested, uint256 available);
    error InsufficientAllowance(uint256 requested, uint256 available);

    constructor(string memory tokenName, string memory tokenSymbol, uint8 tokenDecimals) {
        name = tokenName;
        symbol = tokenSymbol;
        decimals = tokenDecimals;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance(amount, allowed);
            allowance[from][msg.sender] = allowed - amount;
            emit Approval(from, msg.sender, allowance[from][msg.sender]);
        }

        _transfer(from, to, amount);
        return true;
    }

    function mint(address to, uint256 amount) external payable virtual {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external virtual {
        _burn(from, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (from == address(0) || to == address(0)) revert InvalidAddress();

        uint256 fromBalance = balanceOf[from];
        if (fromBalance < amount) revert InsufficientBalance(amount, fromBalance);

        unchecked {
            balanceOf[from] = fromBalance - amount;
            balanceOf[to] += amount;
        }

        emit Transfer(from, to, amount);
    }

    function _mint(address to, uint256 amount) internal {
        if (to == address(0)) revert InvalidAddress();

        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _burn(address from, uint256 amount) internal {
        if (from == address(0)) revert InvalidAddress();

        uint256 fromBalance = balanceOf[from];
        if (fromBalance < amount) revert InsufficientBalance(amount, fromBalance);

        unchecked {
            balanceOf[from] = fromBalance - amount;
            totalSupply -= amount;
        }

        emit Transfer(from, address(0), amount);
    }
}
