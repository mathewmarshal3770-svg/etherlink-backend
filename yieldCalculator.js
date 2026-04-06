const { ethers } = require('ethers');
require('dotenv').config();

// Etherlink Shadownet Testnet RPC URL (must match backend/main.js)
const ETHERLINK_SHADOWNET_RPC = 'https://node.shadownet.etherlink.com';

// YieldCalculator Contract ABI
const YIELD_CALCULATOR_ABI = [
    "function createDeposit(address tokenAddress, uint256 amount, uint256 apy) returns ()",
    "function calculateYield(uint256 depositId, uint256 timeInSeconds) view returns (uint256)",
    "function getCurrentYield(uint256 depositId) view returns (uint256)",
    "function getTotalAmount(uint256 depositId) view returns (uint256)",
    "function withdraw(uint256 depositId) returns ()",
    "function getUserDeposits(address user) view returns (uint256[])",
    "function getDepositInfo(uint256 depositId) view returns (address depositor, address tokenAddress, uint256 amount, uint256 apy, uint256 depositTime, bool active)",
    "function getDepositTokenAddress(uint256 depositId) view returns (address)",
    "function getStats() view returns (uint256 _totalDeposits, uint256 _totalYieldGenerated, uint256 _totalDepositsCount)",
    "function totalDeposits() view returns (uint256)",
    "function totalYieldGenerated() view returns (uint256)",
    "function deposits(uint256) view returns (address depositor, address tokenAddress, uint256 amount, uint256 apy, uint256 depositTime, bool active)",
    "event DepositCreated(address indexed depositor, uint256 depositId, address indexed tokenAddress, uint256 amount, uint256 apy)",
    "event YieldCalculated(address indexed depositor, uint256 depositId, uint256 yieldAmount)",
    "event Withdrawn(address indexed to, uint256 depositId, uint256 amount)"
];

// Standard ERC20 ABI
const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function name() view returns (string)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)"
];

/**
 * Yield Calculator Tool
 * A utility to interact with the YieldCalculator contract (using ERC20 tokens)
 */
class YieldCalculatorTool {
    constructor(contractAddress, privateKey = null) {
        this.provider = new ethers.JsonRpcProvider(ETHERLINK_SHADOWNET_RPC);
        this.contractAddress = contractAddress;
        
        if (privateKey) {
            this.wallet = new ethers.Wallet(privateKey, this.provider);
            this.contract = new ethers.Contract(contractAddress, YIELD_CALCULATOR_ABI, this.wallet);
        } else {
            this.contract = new ethers.Contract(contractAddress, YIELD_CALCULATOR_ABI, this.provider);
        }
    }
    
    /**
     * Initialize token contract and get decimals for a specific token address
     */
    async initializeToken(tokenAddress) {
        if (!tokenAddress) {
            throw new Error("Token address is required");
        }
        
        const signer = this.wallet || this.provider;
        const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
        
        let decimals = 18;
        try {
            decimals = await token.decimals();
        } catch (e) {
            console.warn("Could not fetch token decimals, using default 18");
        }
        
        return { token, decimals };
    }
    
    /**
     * Format token amount for display
     */
    formatToken(amount, decimals) {
        return ethers.formatUnits(amount, decimals);
    }
    
    /**
     * Parse token amount from user input
     */
    parseToken(amount, decimals) {
        return ethers.parseUnits(amount.toString(), decimals);
    }
    
    /**
     * Create a new deposit
     * @param {string} tokenAddress - Address of the ERC20 token to deposit
     * @param {string} amountInTokens - Amount in tokens (e.g., "100")
     * @param {number} apyPercent - APY as percentage (e.g., 5 for 5%)
     * @returns {Promise<string>} Deposit ID
     */
    async createDeposit(tokenAddress, amountInTokens, apyPercent) {
        if (!this.wallet) {
            throw new Error("Wallet not initialized. Provide privateKey to perform transactions.");
        }
        
        if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
            throw new Error("Invalid token address");
        }
        
        const { token, decimals } = await this.initializeToken(tokenAddress);
        const amount = this.parseToken(amountInTokens, decimals);
        const apy = BigInt(Math.floor(apyPercent * 100)); // Convert to basis points
        
        // Check token balance
        const balance = await token.balanceOf(this.wallet.address);
        if (balance < amount) {
            throw new Error(`Insufficient token balance. Have: ${this.formatToken(balance, decimals)}, Need: ${amountInTokens}`);
        }
        
        // Check and approve if needed
        const allowance = await token.allowance(this.wallet.address, this.contractAddress);
        if (allowance < amount) {
            console.log(`Approving tokens...`);
            const approveTx = await token.approve(this.contractAddress, ethers.MaxUint256);
            await approveTx.wait();
            console.log(`✅ Approval confirmed`);
        }
        
        console.log(`Creating deposit: ${amountInTokens} tokens at ${apyPercent}% APY...`);
        
        const tx = await this.contract.createDeposit(tokenAddress, amount, apy);
        const receipt = await tx.wait();
        
        // Find the DepositCreated event
        const event = receipt.logs.find(log => {
            try {
                const parsed = this.contract.interface.parseLog(log);
                return parsed.name === 'DepositCreated';
            } catch (e) {
                return false;
            }
        });
        
        if (event) {
            const parsed = this.contract.interface.parseLog(event);
            const depositId = parsed.args.depositId;
            console.log(`✅ Deposit created! Deposit ID: ${depositId.toString()}`);
            return depositId.toString();
        }
        
        return tx.hash;
    }
    
    /**
     * Calculate yield for a deposit over a time period
     * @param {number} depositId - Deposit ID
     * @param {number} days - Number of days to calculate yield for
     * @returns {Promise<string>} Yield amount in tokens
     */
    async calculateYield(depositId, days) {
        const depositInfo = await this.contract.getDepositInfo(depositId);
        const { token, decimals } = await this.initializeToken(depositInfo.tokenAddress);
        const timeInSeconds = BigInt(days * 24 * 60 * 60);
        const yieldAmount = await this.contract.calculateYield(depositId, timeInSeconds);
        return this.formatToken(yieldAmount, decimals);
    }
    
    /**
     * Get current yield for a deposit
     * @param {number} depositId - Deposit ID
     * @returns {Promise<Object>} Yield information
     */
    async getCurrentYield(depositId) {
        const depositInfo = await this.contract.getDepositInfo(depositId);
        const { token, decimals } = await this.initializeToken(depositInfo.tokenAddress);
        
        const [yieldAmount, totalAmount] = await Promise.all([
            this.contract.getCurrentYield(depositId),
            this.contract.getTotalAmount(depositId)
        ]);
        
        const currentTime = Math.floor(Date.now() / 1000);
        const timePassed = BigInt(currentTime) - depositInfo.depositTime;
        const daysPassed = Number(timePassed) / (24 * 60 * 60);
        
        let tokenSymbol = "TOKEN";
        try {
            tokenSymbol = await token.symbol();
        } catch (e) {
            // Ignore
        }
        
        return {
            depositId,
            tokenAddress: depositInfo.tokenAddress,
            tokenSymbol: tokenSymbol,
            principal: this.formatToken(depositInfo.amount, decimals),
            yieldAmount: this.formatToken(yieldAmount, decimals),
            totalAmount: this.formatToken(totalAmount, decimals),
            apy: Number(depositInfo.apy) / 100 + '%',
            daysPassed: daysPassed.toFixed(2),
            active: depositInfo.active
        };
    }
    
    /**
     * Withdraw a deposit
     * @param {number} depositId - Deposit ID
     * @returns {Promise<string>} Transaction hash
     */
    async withdraw(depositId) {
        if (!this.wallet) {
            throw new Error("Wallet not initialized. Provide privateKey to perform transactions.");
        }
        
        console.log(`Withdrawing deposit ${depositId}...`);
        const tx = await this.contract.withdraw(depositId);
        const receipt = await tx.wait();
        console.log(`✅ Withdrawal successful! TX: ${tx.hash}`);
        return tx.hash;
    }
    
    /**
     * Get all deposits for a user
     * @param {string} userAddress - User's address (optional, defaults to wallet address)
     * @returns {Promise<Array>} Array of deposit IDs
     */
    async getUserDeposits(userAddress = null) {
        const address = userAddress || (this.wallet ? this.wallet.address : null);
        if (!address) {
            throw new Error("No address provided and wallet not initialized.");
        }
        
        const depositIds = await this.contract.getUserDeposits(address);
        return depositIds.map(id => id.toString());
    }
    
    /**
     * Get contract statistics
     * @returns {Promise<Object>} Contract stats
     */
    async getStats() {
        const [stats, totalDeposits, totalYield] = await Promise.all([
            this.contract.getStats(),
            this.contract.totalDeposits(),
            this.contract.totalYieldGenerated()
        ]);
        
        // Note: stats are in raw token units (18 decimals assumed for display)
        // In reality, different deposits may use different tokens with different decimals
        return {
            totalDeposits: stats[0].toString(),
            totalYieldGenerated: stats[1].toString(),
            totalDepositsCount: stats[2].toString(),
            currentTotalDeposits: totalDeposits.toString(),
            currentTotalYield: totalYield.toString(),
            note: "Amounts are in raw token units. Each deposit may use a different token."
        };
    }
    
    /**
     * Calculate and display yield projections
     * @param {number} depositId - Deposit ID
     * @param {Array<number>} timePeriods - Array of days to project
     */
    async projectYield(depositId, timePeriods = [30, 60, 90, 180, 365]) {
        const depositInfo = await this.contract.getDepositInfo(depositId);
        const { token, decimals } = await this.initializeToken(depositInfo.tokenAddress);
        const principal = this.formatToken(depositInfo.amount, decimals);
        const apyPercent = Number(depositInfo.apy) / 100;
        
        let tokenSymbol = "TOKENS";
        try {
            tokenSymbol = await token.symbol();
        } catch (e) {
            // Ignore
        }
        
        console.log(`\n📊 Yield Projections for Deposit #${depositId}`);
        console.log(`Token: ${tokenSymbol} (${depositInfo.tokenAddress})`);
        console.log(`Principal: ${principal} ${tokenSymbol}`);
        console.log(`APY: ${apyPercent}%`);
        console.log(`\nTime Period | Yield Amount | Total Value`);
        console.log(`------------|--------------|------------`);
        
        for (const days of timePeriods) {
            const yieldAmount = await this.calculateYield(depositId, days);
            const totalValue = (parseFloat(principal) + parseFloat(yieldAmount)).toFixed(6);
            console.log(`${days.toString().padStart(11)} days | ${yieldAmount.padStart(12)} ${tokenSymbol} | ${totalValue} ${tokenSymbol}`);
        }
    }
}

// CLI Interface
async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    
    if (!command) {
        console.log(`
Yield Calculator Tool
=====================

Usage: node yieldCalculator.js <command> [args...]

Commands:
  create <tokenAddress> <amount> <apy>    Create a deposit (token address, amount, apy as %)
  yield <depositId>                       Get current yield for a deposit
  project <depositId>                      Show yield projections
  withdraw <depositId>                     Withdraw a deposit
  list [address]                           List deposits for address
  stats                                    Get contract statistics

Examples:
  node yieldCalculator.js create 0x... 100 5    # Create 100 token deposit at 5% APY
  node yieldCalculator.js yield 0                # Get yield for deposit #0
  node yieldCalculator.js project 0               # Show projections for deposit #0
  node yieldCalculator.js stats                   # Get contract stats

Environment Variables:
  YIELD_CALCULATOR_ADDRESS          Contract address (required)
  PRIVATE_KEY                        Private key for transactions (optional for view functions)
        `);
        return;
    }
    
    const contractAddress = process.env.YIELD_CALCULATOR_ADDRESS;
    if (!contractAddress) {
        console.error("❌ Error: YIELD_CALCULATOR_ADDRESS not set in environment");
        return;
    }
    
    const privateKey = process.env.PRIVATE_KEY;
    const tool = new YieldCalculatorTool(contractAddress, privateKey);
    
    try {
        switch (command) {
            case 'create':
                if (args.length < 4) {
                    console.error("Usage: create <tokenAddress> <amount> <apy>");
                    return;
                }
                const depositId = await tool.createDeposit(args[1], args[2], parseFloat(args[3]));
                console.log(`Deposit ID: ${depositId}`);
                break;
                
            case 'yield':
                if (args.length < 2) {
                    console.error("Usage: yield <depositId>");
                    return;
                }
                const yieldInfo = await tool.getCurrentYield(parseInt(args[1]));
                console.log("\n📈 Current Yield Info:");
                console.log(JSON.stringify(yieldInfo, null, 2));
                break;
                
            case 'project':
                if (args.length < 2) {
                    console.error("Usage: project <depositId>");
                    return;
                }
                await tool.projectYield(parseInt(args[1]));
                break;
                
            case 'withdraw':
                if (args.length < 2) {
                    console.error("Usage: withdraw <depositId>");
                    return;
                }
                await tool.withdraw(parseInt(args[1]));
                break;
                
            case 'list':
                const address = args[1] || null;
                const deposits = await tool.getUserDeposits(address);
                console.log(`\n📋 Deposits: ${deposits.length}`);
                if (deposits.length > 0) {
                    for (const id of deposits) {
                        const info = await tool.getCurrentYield(parseInt(id));
                        console.log(`  Deposit #${id}: ${info.principal} ${info.tokenSymbol} @ ${info.apy} (Yield: ${info.yieldAmount} ${info.tokenSymbol})`);
                    }
                }
                break;
                
            case 'stats':
                const stats = await tool.getStats();
                console.log("\n📊 Contract Statistics:");
                console.log(JSON.stringify(stats, null, 2));
                break;
                
            default:
                console.error(`Unknown command: ${command}`);
        }
    } catch (error) {
        console.error(`❌ Error: ${error.message}`);
        if (error.reason) {
            console.error(`Reason: ${error.reason}`);
        }
    }
}

// Run CLI if executed directly
if (require.main === module) {
    main().catch(console.error);
}

module.exports = YieldCalculatorTool;

