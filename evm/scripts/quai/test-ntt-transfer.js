const { quais } = require('quais');
const { ethers } = require('ethers');
const axios = require('axios');
const NttManagerArtifact = require("../../artifacts/src/NttManager/NttManager.sol/NttManager.json");

// Configuration
const QUAI_RPC = 'https://orchard.rpc.quai.network';
const SEPOLIA_RPC = 'https://eth-sepolia.g.alchemy.com/public'; // Replace with your RPC
const GUARDIAN_RPC = 'http://localhost:7071';

// Contract addresses from your deployments
const QUAI_NTT_MANAGER = '0x0040f2d300877eC4C21121C0624f8ace780C0590';
const SEPOLIA_NTT_MANAGER = '0x6f847cC817F5f3Fc9aeb2951259058d5C8801cfF';
const WQUAI_TOKEN = '0x005c46f661Baef20671943f2b4c087Df3E7CEb13';
const BRIDGED_WQUAI = '0xd5a7cda49e2fb7c147376a4ac18c189603fe30a7';

// NTT Manager ABI (minimal)
const NTT_MANAGER_ABI = NttManagerArtifact.abi;
// ERC20 ABI (minimal)
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

// WQUAI ABI (includes deposit for wrapping)
const WQUAI_ABI = [
  ...ERC20_ABI,
  'function deposit() payable',
  'function withdraw(uint256 amount)',
];

async function testNttTransfer() {
  const privateKey = "0xafc63b693d736eaaf06eef222c93c7081a8066dfb9ce1cd0dfb8a5ad42a2515e";
  // Setup providers and signers
  const quaiProvider = new quais.JsonRpcProvider(QUAI_RPC, undefined, {
    // Quai requires pathing
    usePathing: true,
  });
  const sepoliaProvider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const quaiSigner = new quais.Wallet(privateKey, quaiProvider);
  const sepoliaSigner = new ethers.Wallet(privateKey, sepoliaProvider);

  // Setup contracts
  const wquaiToken = new quais.Contract(WQUAI_TOKEN, WQUAI_ABI, quaiSigner);
  const quaiNttManager = new quais.Contract(QUAI_NTT_MANAGER, NTT_MANAGER_ABI, quaiSigner);
  const sepoliaNttManager = new ethers.Contract(SEPOLIA_NTT_MANAGER, NTT_MANAGER_ABI, sepoliaSigner);

  console.log('Testing NTT Transfer from Quai to Sepolia...');
  console.log('Sender address:', quaiSigner.address);

  // 0. Check native QUAI balance and wrap if needed
  const nativeBalance = await quaiProvider.getBalance(quaiSigner.address);
  console.log('Native QUAI balance:', quais.formatQuai(nativeBalance));
  
  // 1. Check WQUAI balance
  const balance = await wquaiToken.balanceOf(quaiSigner.address);
  const decimals = await wquaiToken.decimals();
  console.log('WQUAI balance:', quais.formatUnits(balance, decimals));
  
  // Wrap QUAI to WQUAI if balance is low
  const transferAmount = quais.parseUnits('1', decimals); // 1 WQUAI
  if (balance < transferAmount) {
    console.log('Wrapping QUAI to WQUAI...');
    const wrapAmount = transferAmount - balance; // Wrap enough to have 1 WQUAI
    const wrapTx = await wquaiToken.deposit({ value: wrapAmount, gasLimit: 500000 });
    await wrapTx.wait();
    console.log('Wrapped', quais.formatUnits(wrapAmount, decimals), 'QUAI to WQUAI');
    
    // Check new balance
    const newBalance = await wquaiToken.balanceOf(quaiSigner.address);
    console.log('New WQUAI balance:', quais.formatUnits(newBalance, decimals));
  }
  // 2. Approve NTT Manager to spend WQUAI
  console.log('Approving NTT Manager to spend', quais.formatUnits(transferAmount, decimals), 'WQUAI...');
  const approveTx = await wquaiToken.approve(QUAI_NTT_MANAGER, transferAmount, { gasLimit: 500000 });
  await approveTx.wait();
  console.log('Approval confirmed');

  // 3. Quote delivery price
  const targetChain = 10002; // Sepolia chain ID in Wormhole
  let deliveryFee = 0n;
  
  console.log('Quoting delivery price for Sepolia...');
  try {
    const [priceArray, totalPrice] = await quaiNttManager.quoteDeliveryPrice(targetChain, '0x');
    console.log('Delivery prices:', priceArray.map(p => quais.formatQuai(p)));
    console.log('Total delivery fee:', quais.formatQuai(totalPrice), 'QUAI');
    deliveryFee = totalPrice;
  } catch (error) {
    console.log('Failed to quote delivery price:', error.message);
    console.log('Proceeding with 0 delivery fee...');
  }
  
  // 4. Initiate transfer
  console.log('\nInitiating transfer...');
  const recipient = quais.zeroPadValue(quaiSigner.address, 32); // Same address on destination
  
  let transferTx;
  try {
    transferTx = await quaiNttManager.transfer(
      transferAmount,
      targetChain,
      recipient,
      { value: deliveryFee, gasLimit: 1000000 }
    );
    console.log('Transfer transaction sent!');
  } catch (transferError) {
    console.error('Transfer failed:', transferError.message);
    
    // Try with a small fee if delivery fee was 0
    if (deliveryFee === 0n) {
      console.log('\nTrying with 0.01 QUAI delivery fee...');
      transferTx = await quaiNttManager.transfer(
        transferAmount,
        targetChain,
        recipient,
        { value: quais.parseQuai('0.01'), gasLimit: 1000000 }
      );
    } else {
      throw transferError;
    }
  }
  
  const receipt = await transferTx.wait();
  console.log('Transfer tx hash:', receipt.hash);

  // 5. Extract the sequence number from logs
  // The LogMessagePublished event contains the sequence
  const logs = receipt.logs;
  let sequence;
  let actualEmitter;
  
  console.log('\nAnalyzing transaction logs...');
  console.log('Total logs:', logs.length);
  
  for (const log of logs) {
    console.log('Log from:', log.address);
    if (log.address.toLowerCase() === '0x004Accf29dD34f88E885e2BdFB1B0105059b3D08'.toLowerCase()) {
      // This is the Wormhole Core contract
      console.log('Found Wormhole Core log');
      // Parse LogMessagePublished event
      // The event signature for LogMessagePublished
      if (log.topics[0] === '0x6eb224fb001ed210e379b335e35efe88672a8ce935d981a6896b27ffdf52a3b2') {
        // Extract emitter from topics[1]
        actualEmitter = '0x' + log.topics[1].slice(26); // Remove padding
        // Sequence is the first 32 bytes of data (uint64 padded to 32 bytes)
        sequence = parseInt(log.data.slice(2, 66), 16); // First 32 bytes (64 hex chars)
        console.log('LogMessagePublished:');
        console.log('  Emitter:', actualEmitter);
        console.log('  Sequence:', sequence);
        console.log('  Raw sequence data:', log.data.slice(2, 66));
        break;
      }
    }
  }

  // 6. Wait for guardian to sign the VAA
  console.log('Waiting for VAA to be signed...');
  await new Promise(resolve => setTimeout(resolve, 60000)); // Wait 60 seconds

  // 7. Fetch VAA from guardian
  // Use the actual emitter from the logs (likely the transceiver)
  const emitterAddress = actualEmitter ? quais.zeroPadValue(actualEmitter, 32).slice(2) : quais.zeroPadValue(QUAI_NTT_MANAGER, 32).slice(2);
  const vaaUrl = `${GUARDIAN_RPC}/v1/signed_vaa/15000/${emitterAddress}/${sequence}`;
  
  console.log('\nFetching VAA from:', vaaUrl);
  console.log('Chain ID:', 15000);
  console.log('Emitter address:', '0x' + emitterAddress);
  console.log('Sequence:', sequence);
  
  try {
    const response = await axios.get(vaaUrl);
    const vaa = response.data.vaaBytes;
    console.log('VAA retrieved:', vaa);

    // 8. Redeem on Sepolia
    console.log('\nRedeeming on Sepolia...');
    // Convert base64 VAA to hex format
    const vaaBytes = Buffer.from(vaa, 'base64');
    const vaaHex = '0x' + vaaBytes.toString('hex');
    console.log('VAA hex length:', vaaHex.length);
    
    try {
      // First check the balance before
      const bridgedToken = new ethers.Contract(BRIDGED_WQUAI, ERC20_ABI, sepoliaSigner);
      const balanceBefore = await bridgedToken.balanceOf(sepoliaSigner.address);
      console.log(`Balance before: ${ethers.formatUnits(balanceBefore, 18)} WQUAI`);
      
      // Get the transceiver address on Sepolia
      const transceivers = await sepoliaNttManager.getTransceivers();
      if (transceivers.length === 0) {
        throw new Error('No transceiver found on Sepolia. Transceivers: ' + transceivers);
      }
      const sepoliaTransceiver = transceivers[0]; // It's just an address array
      console.log('Sepolia transceiver:', sepoliaTransceiver);
      
      // The WormholeTransceiver has the receiveMessage function that accepts the VAA directly
      const transceiverAbi = [
        'function receiveMessage(bytes memory encodedMessage) external'
      ];
      const transceiver = new ethers.Contract(sepoliaTransceiver, transceiverAbi, sepoliaSigner);
      
      // Call receiveMessage with the VAA
      console.log('Calling receiveMessage on transceiver...');
      const redeemTx = await transceiver.receiveMessage(vaaHex, { gasLimit: 1000000 });
      
      console.log('Redeem tx submitted:', redeemTx.hash);
      const redeemReceipt = await redeemTx.wait();
      console.log('Redeem confirmed!');
      console.log('Gas used:', redeemReceipt.gasUsed.toString());
      
      // Check the balance after
      const balanceAfter = await bridgedToken.balanceOf(sepoliaSigner.address);
      console.log(`\nBalance after: ${ethers.formatUnits(balanceAfter, 18)} WQUAI`);
      
      const received = balanceAfter - balanceBefore;
      if (received > 0n) {
        console.log(`Received: ${ethers.formatUnits(received, 18)} WQUAI`);
        console.log('✅ Transfer complete!');
      } else {
        console.log('⚠️  Balance did not increase. The VAA might have already been processed.');
      }
    } catch (error) {
      console.error('Error redeeming:', error.message);
      if (error.data) {
        console.error('Error data:', error.data);
      }
    }

  } catch (error) {
    console.error('Error fetching VAA:', error.message);
    console.log('Make sure your guardian is running and has observed the transaction');
  }
}

async function bridgeBackToQuai() {
  const privateKey = "0xafc63b693d736eaaf06eef222c93c7081a8066dfb9ce1cd0dfb8a5ad42a2515e";
  // Setup providers and signers
  const quaiProvider = new quais.JsonRpcProvider(QUAI_RPC, undefined, {
    usePathing: true,
  });
  const sepoliaProvider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const quaiSigner = new quais.Wallet(privateKey, quaiProvider);
  const sepoliaSigner = new ethers.Wallet(privateKey, sepoliaProvider);

  // Setup contracts
  const bridgedWquai = new ethers.Contract(BRIDGED_WQUAI, ERC20_ABI, sepoliaSigner);
  const sepoliaNttManager = new ethers.Contract(SEPOLIA_NTT_MANAGER, NTT_MANAGER_ABI, sepoliaSigner);
  const quaiNttManager = new quais.Contract(QUAI_NTT_MANAGER, NTT_MANAGER_ABI, quaiSigner);

  console.log('=== Bridging WQUAI from Sepolia back to Quai ===');
  console.log('Sender address:', sepoliaSigner.address);

  // 1. Check bridged WQUAI balance on Sepolia
  const balance = await bridgedWquai.balanceOf(sepoliaSigner.address);
  const decimals = await bridgedWquai.decimals();
  console.log('Bridged WQUAI balance on Sepolia:', ethers.formatUnits(balance, decimals));
  
  if (balance === 0n) {
    throw new Error('No bridged WQUAI balance on Sepolia to bridge back');
  }

  // Use the full balance or 1 WQUAI, whichever is less
  const transferAmount = balance < ethers.parseUnits('1', decimals) ? balance : ethers.parseUnits('1', decimals);
  console.log('Amount to bridge back:', ethers.formatUnits(transferAmount, decimals), 'WQUAI');

  // 2. Approve Sepolia NTT Manager to spend bridged WQUAI
  console.log('\nApproving Sepolia NTT Manager to spend WQUAI...');
  const approveTx = await bridgedWquai.approve(SEPOLIA_NTT_MANAGER, transferAmount);
  await approveTx.wait();
  console.log('Approval confirmed');

  // 3. Quote delivery price
  const targetChain = 15000; // Quai chain ID in Wormhole
  let deliveryFee = 0n;
  
  console.log('Quoting delivery price for Quai...');
  try {
    const [priceArray, totalPrice] = await sepoliaNttManager.quoteDeliveryPrice(targetChain, '0x');
    console.log('Delivery prices:', priceArray.map(p => ethers.formatEther(p)));
    console.log('Total delivery fee:', ethers.formatEther(totalPrice), 'ETH');
    deliveryFee = totalPrice;
  } catch (error) {
    console.log('Failed to quote delivery price:', error.message);
    console.log('Proceeding with 0 delivery fee...');
  }
  
  // 4. Initiate transfer back to Quai
  console.log('\nInitiating transfer back to Quai...');
  const recipient = ethers.zeroPadValue(sepoliaSigner.address, 32); // Same address on destination
  
  let transferTx;
  try {
    transferTx = await sepoliaNttManager.transfer(
      transferAmount,
      targetChain,
      recipient,
      { value: deliveryFee }
    );
    console.log('Transfer transaction sent!');
  } catch (transferError) {
    console.error('Transfer failed:', transferError.message);
    
    // Try with a small fee if delivery fee was 0
    if (deliveryFee === 0n) {
      console.log('\nTrying with 0.001 ETH delivery fee...');
      transferTx = await sepoliaNttManager.transfer(
        transferAmount,
        targetChain,
        recipient,
        { value: ethers.parseEther('0.001') }
      );
    } else {
      throw transferError;
    }
  }
  
  const receipt = await transferTx.wait();
  console.log('Transfer tx hash:', receipt.hash);

  // 5. Extract the sequence number from logs
  let sequence;
  let actualEmitter;
  
  console.log('\nAnalyzing transaction logs...');
  console.log('Total logs:', receipt.logs.length);
  
  // Find the Wormhole Core contract address on Sepolia
  const SEPOLIA_WORMHOLE_CORE = '0x9b4C71FcE35aC14aeA71179aba932046f713a8DE';
  
  for (const log of receipt.logs) {
    console.log('Log from:', log.address);
    if (log.address.toLowerCase() === SEPOLIA_WORMHOLE_CORE.toLowerCase()) {
      console.log('Found Wormhole Core log');
      // Parse LogMessagePublished event
      if (log.topics[0] === '0x6eb224fb001ed210e379b335e35efe88672a8ce935d981a6896b27ffdf52a3b2') {
        // Extract emitter from topics[1]
        actualEmitter = '0x' + log.topics[1].slice(26);
        // Sequence is the first 32 bytes of data
        sequence = parseInt(log.data.slice(2, 66), 16);
        console.log('LogMessagePublished:');
        console.log('  Emitter:', actualEmitter);
        console.log('  Sequence:', sequence);
        console.log('  Raw sequence data:', log.data.slice(2, 66));
        break;
      }
    }
  }

  if (!sequence) {
    throw new Error('Could not find sequence number in transaction logs');
  }

  // 6. Wait for guardian to sign the VAA
  console.log('\nWaiting for VAA to be signed...');
  await new Promise(resolve => setTimeout(resolve, 30000)); // Wait 30 seconds

  // 7. Fetch VAA from guardian
  const emitterAddress = actualEmitter ? ethers.zeroPadValue(actualEmitter, 32).slice(2) : 
                          ethers.zeroPadValue(sepoliaNttManager.target, 32).slice(2);
  const vaaUrl = `${GUARDIAN_RPC}/v1/signed_vaa/10002/${emitterAddress}/${sequence}`;
  
  console.log('\nFetching VAA from:', vaaUrl);
  console.log('Chain ID:', 10002);
  console.log('Emitter address:', '0x' + emitterAddress);
  console.log('Sequence:', sequence);
  
  try {
    const response = await axios.get(vaaUrl);
    const vaa = response.data.vaaBytes;
    console.log('VAA retrieved:', vaa);

    // 8. Redeem on Quai
    console.log('\nRedeeming on Quai...');
    // Convert base64 VAA to hex format
    const vaaBytes = Buffer.from(vaa, 'base64');
    const vaaHex = '0x' + vaaBytes.toString('hex');
    console.log('VAA hex length:', vaaHex.length);
    
    try {
      // Check WQUAI balance before on Quai
      const wquaiToken = new quais.Contract(WQUAI_TOKEN, ERC20_ABI, quaiSigner);
      const balanceBefore = await wquaiToken.balanceOf(quaiSigner.address);
      console.log(`WQUAI balance before: ${quais.formatUnits(balanceBefore, decimals)}`);
      
      // Get the transceiver address on Quai
      const transceivers = await quaiNttManager.getTransceivers();
      if (transceivers.length === 0) {
        throw new Error('No transceiver found on Quai');
      }
      const quaiTransceiver = transceivers[0];
      console.log('Quai transceiver:', quaiTransceiver);
      
      // The WormholeTransceiver has the receiveMessage function
      const transceiverAbi = [
        'function receiveMessage(bytes memory encodedMessage) external'
      ];
      const transceiver = new quais.Contract(quaiTransceiver, transceiverAbi, quaiSigner);
      
      // Call receiveMessage with the VAA
      console.log('Calling receiveMessage on transceiver...');
      const redeemTx = await transceiver.receiveMessage(vaaHex, { gasLimit: 1000000 });
      
      console.log('Redeem tx submitted:', redeemTx.hash);
      const redeemReceipt = await redeemTx.wait();
      console.log('Redeem confirmed!');
      console.log('Gas used:', redeemReceipt.gasUsed.toString());
      
      // Check the balance after
      const balanceAfter = await wquaiToken.balanceOf(quaiSigner.address);
      console.log(`\nWQUAI balance after: ${quais.formatUnits(balanceAfter, decimals)}`);
      
      const received = balanceAfter - balanceBefore;
      if (received > 0n) {
        console.log(`Received: ${quais.formatUnits(received, decimals)} WQUAI`);
        console.log('✅ Bridge back to Quai complete!');
      } else {
        console.log('⚠️  Balance did not increase. The VAA might have already been processed.');
      }
    } catch (error) {
      console.error('Error redeeming on Quai:', error.message);
      if (error.data) {
        console.error('Error data:', error.data);
      }
    }

  } catch (error) {
    console.error('Error fetching VAA:', error.message);
    console.log('Make sure your guardian is running and has observed the transaction');
  }
}

// Run the test based on command line argument
const command = process.argv[2];
if (command === 'back') {
  bridgeBackToQuai().catch(console.error);
} else {
  testNttTransfer().catch(console.error);
}