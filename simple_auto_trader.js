// simple_auto_trader.js - Auto-trader Jupiter avec ventes échelonnées et monitoring rapide
require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { Connection, Keypair, PublicKey, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');

class SimpleAutoTrader {
    constructor() {
        // Configuration Discord
        this.discordToken = process.env.DISCORD_TOKEN;
        this.channelId = process.env.DISCORD_CHANNEL_ID;
        this.client = new Client({ 
            intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] 
        });
        
        // Configuration Solana avec RPC premium/alternatif
        const rpcUrls = [
            process.env.SOLANA_RPC_URL,
            'https://solana-mainnet.g.alchemy.com/v2/' + (process.env.ALCHEMY_API_KEY || 'demo'),
            'https://api.mainnet-beta.solana.com',
            'https://solana-api.projectserum.com',
            'https://rpc.ankr.com/solana'
        ].filter(url => url && !url.includes('undefined'));
        
        this.connection = new Connection(rpcUrls[0] || 'https://api.mainnet-beta.solana.com', {
    commitment: 'confirmed',
    wsEndpoint: false,  // ← AJOUTER CETTE LIGNE
    httpHeaders: {
        'User-Agent': 'Jupiter-Trader/1.0'
    }
});

// Et pareil pour les backup connections
this.backupConnections = rpcUrls.slice(1).map(url => 
    new Connection(url, { 
        commitment: 'confirmed',
        wsEndpoint: false  // ← AJOUTER CETTE LIGNE
    })
);
        
        this.wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
        
        // Configuration trading
        this.buyAmount = 0.01; // Force à 0.01 SOL
        this.maxSlippage = parseFloat(process.env.MAX_SLIPPAGE || '10');
        
        // Rate limiting pour éviter 429
        this.lastRpcCall = 0;
        this.rpcCallDelay = 1000; // 1 seconde entre appels RPC
        this.balanceCache = new Map(); // Cache des soldes
        this.cacheTimeout = 30000; // 30 secondes de cache
        
        // Configuration ventes échelonnées
        this.sellLevels = [
            { 
                profit: 25,      // +25%
                percentage: 40,  // Vendre 40% de la position
                reason: "Sécurisation rapide (+25%)" 
            },
            { 
                profit: 75,      // +75% 
                percentage: 60,  // Vendre 60% du restant
                reason: "Take-Profit intermédiaire (+75%)" 
            },
            { 
                profit: 200,     // +200%
                percentage: 75,  // Vendre 75% du restant
                reason: "Take-Profit élevé (+200%)" 
            },
            { 
                profit: 500,     // +500%
                percentage: 90,  // Vendre 90% du restant
                reason: "Moonshot (+500%)" 
            }
        ];
        
        // Protections
        this.stopLossPercent = 20; // -20%
        this.useTrailingStop = true;
        this.trailingStopPercent = 15; // -15% depuis le plus haut
        
        // Positions actives
        this.positions = new Map(); // tokenAddress -> position data
        this.postedTokens = new Map(); // Anti-doublons
        this.tokenCooldown = 24 * 60 * 60 * 1000; // 24h
        
        // Critères de filtrage (même que le scanner)
        this.maxAgeHours = 1;
        this.minLiquidity = 5000;
        this.minVolume = 10000;
        this.minChange = 20;
        
        console.log(`💼 Wallet: ${this.wallet.publicKey.toString()}`);
        console.log(`💰 Buy amount: ${this.buyAmount} SOL`);
        console.log(`🎯 Ventes échelonnées: ${this.sellLevels.length} niveaux`);
        console.log(`📉 Stop loss: -${this.stopLossPercent}%`);
        console.log(`📈 Trailing stop: -${this.trailingStopPercent}%`);
    }

    // Initialiser Discord
    async initializeDiscord() {
        try {
            console.log('🤖 Connexion à Discord...');
            await this.client.login(this.discordToken);
            
            this.client.once('ready', () => {
                console.log(`✅ Bot connecté: ${this.client.user.tag}`);
            });
            
            return true;
        } catch (error) {
            console.error('❌ Erreur connexion Discord:', error.message);
            return false;
        }
    }
    async confirmTransactionPolling(txid, maxRetries = 30) {
    console.log(`⏳ Confirmation transaction par polling: ${txid}`);
    
    for (let i = 0; i < maxRetries; i++) {
        try {
            await this.waitForRateLimit();
            
            const status = await this.connection.getSignatureStatus(txid);
            
            if (status?.value?.confirmationStatus === 'confirmed' || 
                status?.value?.confirmationStatus === 'finalized') {
                console.log(`✅ Transaction confirmée en ${i + 1} tentatives`);
                return true;
            }
            
            if (status?.value?.err) {
                console.log(`❌ Transaction échouée: ${JSON.stringify(status.value.err)}`);
                return false;
            }
            
            await new Promise(resolve => setTimeout(resolve, 2000));
            
        } catch (error) {
            console.log(`⚠️ Erreur vérification ${i + 1}: ${error.message}`);
            if (i === maxRetries - 1) return false;
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    return false;
}
    // Scanner les nouveaux tokens (même logique que le scanner)
// Scanner amélioré avec tokens récents ET performants
async scanNewTokens() {
    console.log('🔍 Recherche de nouveaux tokens...');
    
    try {
        const newTokens = [];
        
        // 1. TOKENS RÉCENTS (moins d'1h) - logique existante
        console.log('   📍 Scan tokens récents (<1h)...');
        const trendingResponse = await fetch('https://api.dexscreener.com/token-profiles/latest/v1');
        
        if (trendingResponse.ok) {
            const trendingData = await trendingResponse.json();
            
            for (const tokenProfile of trendingData.slice(0, 10)) {
                try {
                    if (tokenProfile.tokenAddress) {
                        const pairsResponse = await fetch(
                            `https://api.dexscreener.com/latest/dex/tokens/${tokenProfile.tokenAddress}`
                        );
                        
                        if (pairsResponse.ok) {
                            const pairsData = await pairsResponse.json();
                            
                            if (pairsData.pairs) {
                                const recentSolanaPairs = pairsData.pairs.filter(pair => {
                                    if (pair.chainId !== 'solana') return false;
                                    
                                    const age = this.calculateAge(pair.pairCreatedAt);
                                    const liquidity = parseFloat(pair.liquidity?.usd || 0);
                                    const volume24h = parseFloat(pair.volume?.h24 || 0);
                                    const change24h = parseFloat(pair.priceChange?.h24 || 0);
                                    
                                    return age <= this.maxAgeHours && 
                                           liquidity >= this.minLiquidity &&
                                           volume24h >= this.minVolume &&
                                           change24h >= this.minChange;
                                });
                                
                                newTokens.push(...recentSolanaPairs);
                            }
                        }
                        
                        await new Promise(resolve => setTimeout(resolve, 300));
                    }
                } catch (error) {
                    console.log(`⚠️ Erreur token récent ${tokenProfile.tokenAddress}: ${error.message}`);
                }
            }
        }
        
        // 2. TOKENS PLUS ANCIENS PERFORMANTS (1h à 24h)
        console.log('   🚀 Scan tokens performants (1h-24h)...');
        try {
            // Récupérer les tokens qui gagnent le plus sur Solana
            const gainersResponse = await fetch('https://api.dexscreener.com/latest/dex/search?q=solana');
            
            if (gainersResponse.ok) {
                const gainersData = await gainersResponse.json();
                
                if (gainersData.pairs) {
                    const performantPairs = gainersData.pairs
                        .filter(pair => {
                            if (pair.chainId !== 'solana') return false;
                            
                            const age = this.calculateAge(pair.pairCreatedAt);
                            const liquidity = parseFloat(pair.liquidity?.usd || 0);
                            const volume24h = parseFloat(pair.volume?.h24 || 0);
                            const change24h = parseFloat(pair.priceChange?.h24 || 0);
                            const change6h = parseFloat(pair.priceChange?.h6 || 0);
                            const change1h = parseFloat(pair.priceChange?.h1 || 0);
                            
                            // Critères pour tokens plus anciens mais performants
                            const isOlderButGood = age > 1 && age <= 24 && // Entre 1h et 24h
                                                 liquidity >= 20000 && // Plus de liquidité requise
                                                 volume24h >= 50000 && // Plus de volume requis
                                                 change24h >= 30 && // Au moins +30% sur 24h
                                                 change6h >= 15 && // Au moins +15% sur 6h
                                                 change1h >= 5; // Au moins +5% sur 1h (momentum)
                            
                            return isOlderButGood;
                        })
                        .sort((a, b) => {
                            // Trier par performance 6h (momentum récent)
                            const perfA = parseFloat(a.priceChange?.h6 || 0);
                            const perfB = parseFloat(b.priceChange?.h6 || 0);
                            return perfB - perfA;
                        })
                        .slice(0, 5); // Max 5 tokens performants
                    
                    console.log(`   ✅ Trouvé ${performantPairs.length} tokens performants`);
                    newTokens.push(...performantPairs);
                }
            }
        } catch (error) {
            console.log(`⚠️ Erreur scan tokens performants: ${error.message}`);
        }
        
        // 3. TOKENS TRENDING AVEC FORTE LIQUIDITÉ (backup)
        console.log('   💎 Scan tokens haute liquidité...');
        try {
            // Chercher spécifiquement les tokens avec forte liquidité
            const highLiqResponse = await fetch('https://api.dexscreener.com/latest/dex/tokens/solana');
            
            if (highLiqResponse.ok) {
                const highLiqData = await highLiqResponse.json();
                
                if (highLiqData.pairs) {
                    const highLiqPairs = highLiqData.pairs
                        .filter(pair => {
                            const liquidity = parseFloat(pair.liquidity?.usd || 0);
                            const volume24h = parseFloat(pair.volume?.h24 || 0);
                            const change24h = parseFloat(pair.priceChange?.h24 || 0);
                            const age = this.calculateAge(pair.pairCreatedAt);
                            
                            // Tokens avec très forte liquidité, peu importe l'âge
                            return liquidity >= 100000 && // 100k+ liquidité
                                   volume24h >= 100000 && // 100k+ volume
                                   change24h >= 20 && // Au moins +20%
                                   age && age <= 48; // Max 48h
                        })
                        .sort((a, b) => {
                            // Trier par ratio volume/liquidité (activité)
                            const ratioA = parseFloat(a.volume?.h24 || 0) / parseFloat(a.liquidity?.usd || 1);
                            const ratioB = parseFloat(b.volume?.h24 || 0) / parseFloat(b.liquidity?.usd || 1);
                            return ratioB - ratioA;
                        })
                        .slice(0, 3); // Max 3 tokens haute liquidité
                    
                    console.log(`   ✅ Trouvé ${highLiqPairs.length} tokens haute liquidité`);
                    newTokens.push(...highLiqPairs);
                }
            }
        } catch (error) {
            console.log(`⚠️ Erreur scan haute liquidité: ${error.message}`);
        }
        
        // Dédupliquer et finaliser
        const uniqueTokens = new Map();
        for (const token of newTokens) {
            const address = token.baseToken?.address;
            if (address && !uniqueTokens.has(address)) {
                // Ajouter des infos de scoring
                token.scanReason = this.getScanReason(token);
                uniqueTokens.set(address, token);
            }
        }
        
        const finalTokens = Array.from(uniqueTokens.values())
            .sort((a, b) => {
                // Prioriser par performance 6h puis liquidité
                const perfA = parseFloat(a.priceChange?.h6 || 0);
                const perfB = parseFloat(b.priceChange?.h6 || 0);
                if (perfA !== perfB) return perfB - perfA;
                
                const liqA = parseFloat(a.liquidity?.usd || 0);
                const liqB = parseFloat(b.liquidity?.usd || 0);
                return liqB - liqA;
            })
            .slice(0, 5); // Max 5 tokens au total par scan
        
        console.log(`✅ ${finalTokens.length} tokens sélectionnés au total`);
        
        // Log des tokens sélectionnés avec leurs raisons
        finalTokens.forEach((token, i) => {
            const change6h = parseFloat(token.priceChange?.h6 || 0);
            const liquidity = parseFloat(token.liquidity?.usd || 0);
            const age = this.calculateAge(token.pairCreatedAt);
            console.log(`   ${i+1}. ${token.baseToken?.symbol} - ${token.scanReason} (+${change6h.toFixed(1)}% 6h, $${(liquidity/1000).toFixed(0)}k liq, ${age?.toFixed(1)}h)`);
        });
        
        return finalTokens;
        
    } catch (error) {
        console.error('❌ Erreur scan nouveaux tokens:', error.message);
        return [];
    }
}

// Fonction helper pour identifier la raison du scan
getScanReason(token) {
    const age = this.calculateAge(token.pairCreatedAt);
    const liquidity = parseFloat(token.liquidity?.usd || 0);
    const change24h = parseFloat(token.priceChange?.h24 || 0);
    
    if (age <= 1) {
        return "🆕 Nouveau";
    } else if (liquidity >= 100000) {
        return "💎 Haute liquidité";
    } else if (change24h >= 50) {
        return "🚀 Très performant";
    } else {
        return "📈 Performant";
    }
}

    // Calculer l'âge du token
    calculateAge(createdAt) {
        if (!createdAt) return null;
        try {
            return (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60);
        } catch {
            return null;
        }
    }

    // Vérifier si un token a déjà été traité
    isTokenAlreadyProcessed(tokenAddress) {
        if (!this.postedTokens.has(tokenAddress)) {
            return false;
        }
        
        const lastProcessed = this.postedTokens.get(tokenAddress);
        const timeSinceProcessed = Date.now() - lastProcessed;
        
        if (timeSinceProcessed > this.tokenCooldown) {
            this.postedTokens.delete(tokenAddress);
            return false;
        }
        
        return true;
    }

    // Marquer un token comme traité
    markTokenAsProcessed(tokenAddress) {
        this.postedTokens.set(tokenAddress, Date.now());
    }

    // Rate limiting pour RPC calls
    async waitForRateLimit() {
        const now = Date.now();
        const timeSinceLastCall = now - this.lastRpcCall;
        
        if (timeSinceLastCall < this.rpcCallDelay) {
            const waitTime = this.rpcCallDelay - timeSinceLastCall;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
        this.lastRpcCall = Date.now();
    }

    // Obtenir une connexion avec failover
    async getConnection(attempt = 0) {
        if (attempt === 0) {
            return this.connection;
        } else if (attempt <= this.backupConnections.length) {
            return this.backupConnections[attempt - 1];
        } else {
            return this.connection; // Retour au principal
        }
    }

    // Vérifier le solde avec cache et rate limiting
    async checkWalletBalance(tokenMint, requiredAmount, useCache = true) {
        try {
            const cacheKey = `${tokenMint}_${this.wallet.publicKey.toString()}`;
            
            // Vérifier le cache d'abord
            if (useCache && this.balanceCache.has(cacheKey)) {
                const cached = this.balanceCache.get(cacheKey);
                if (Date.now() - cached.timestamp < this.cacheTimeout) {
                    console.log(`💾 Cache: ${tokenMint === 'So11111111111111111111111111111111111111112' ? 'SOL' : 'Token'} = ${cached.balance}`);
                    return cached.balance >= requiredAmount;
                }
            }

            // Rate limiting
            await this.waitForRateLimit();

            let balance;
            let attempts = 0;
            const maxAttempts = 3;

            while (attempts < maxAttempts) {
                try {
                    const connection = await this.getConnection(attempts);
                    
                    if (tokenMint === 'So11111111111111111111111111111111111111112') {
                        // SOL balance
                        const lamports = await connection.getBalance(this.wallet.publicKey);
                        balance = lamports / 1e9;
                        const requiredSol = requiredAmount / 1e9;
                        
                        console.log(`💰 Solde SOL: ${balance.toFixed(4)} | Requis: ${requiredSol.toFixed(4)}`);
                        
                        // Cache le résultat
                        this.balanceCache.set(cacheKey, { 
                            balance: lamports, 
                            timestamp: Date.now() 
                        });
                        
                        return balance >= requiredSol + 0.01; // +0.01 SOL pour les fees
                    } else {
                        // Token balance
                        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
                            this.wallet.publicKey,
                            { mint: new PublicKey(tokenMint) }
                        );
                        
                        if (tokenAccounts.value.length === 0) {
                            console.log(`❌ Aucun compte token trouvé pour ${tokenMint}`);
                            return false;
                        }
                        
                        balance = parseFloat(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
                        console.log(`💰 Solde token: ${balance} | Requis: ${requiredAmount}`);
                        
                        // Cache le résultat
                        this.balanceCache.set(cacheKey, { 
                            balance: balance, 
                            timestamp: Date.now() 
                        });
                        
                        return balance >= requiredAmount;
                    }
                } catch (rpcError) {
                    attempts++;
                    console.log(`⚠️ RPC Error attempt ${attempts}: ${rpcError.message}`);
                    
                    if (rpcError.message.includes('429') || rpcError.message.includes('Too Many Requests')) {
                        console.log(`🔄 Rate limit hit, waiting ${Math.pow(2, attempts)} seconds...`);
                        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempts) * 1000));
                    } else if (attempts >= maxAttempts) {
                        throw rpcError;
                    }
                }
            }
        } catch (error) {
            console.error(`❌ Erreur vérification solde: ${error.message}`);
            return false;
        }
    }

    // Tester la compatibilité Jupiter et obtenir un quote avec vérifications
    async getJupiterQuote(inputMint, outputMint, amount) {
        try {
            // Vérifier le solde avant de demander un quote
            const hasBalance = await this.checkWalletBalance(inputMint, amount);
            if (!hasBalance) {
                console.log(`❌ Solde insuffisant pour ${inputMint}`);
                return null;
            }

            const response = await fetch(
                `https://quote-api.jup.ag/v6/quote?` +
                `inputMint=${inputMint}&` +
                `outputMint=${outputMint}&` +
                `amount=${amount}&` +
                `slippageBps=${this.maxSlippage * 100}`
            );
            
            if (response.ok) {
                const quote = await response.json();
                if (!quote.error && quote.outAmount) {
                    // Vérifier que le quote est valide
                    const outAmount = parseFloat(quote.outAmount);
                    if (outAmount > 0) {
                        console.log(`✅ Quote Jupiter: ${amount} → ${outAmount}`);
                        return quote;
                    } else {
                        console.log(`❌ Quote invalide: outAmount = ${outAmount}`);
                        return null;
                    }
                } else {
                    console.log(`❌ Quote error: ${quote.error || 'Unknown error'}`);
                    return null;
                }
            } else {
                console.log(`❌ Jupiter API error: ${response.status}`);
                return null;
            }
            
        } catch (error) {
            console.log(`❌ Erreur Jupiter quote: ${error.message}`);
            return null;
        }
    }

    // Exécuter un swap Jupiter avec gestion d'erreurs améliorée
    async executeSwap(quote) {
        try {
            console.log(`🔄 Exécution swap: ${quote.inputMint} → ${quote.outputMint}`);
            console.log(`   📊 Amount: ${quote.inAmount} → ${quote.outAmount}`);
            
            // Double vérification du solde juste avant le swap
            const hasBalance = await this.checkWalletBalance(quote.inputMint, parseFloat(quote.inAmount));
            if (!hasBalance) {
                console.log(`❌ Solde insuffisant au moment du swap`);
                return null;
            }

            // Obtenir la transaction
            const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    quoteResponse: quote,
                    userPublicKey: this.wallet.publicKey.toString(),
                    wrapAndUnwrapSol: true,
                    dynamicComputeUnitLimit: true, // Ajuster automatiquement les compute units
                    prioritizationFeeLamports: 'auto' // Fee automatique pour priorité
                })
            });
            
            if (!swapResponse.ok) {
                const errorText = await swapResponse.text();
                throw new Error(`Swap API error: ${swapResponse.status} - ${errorText}`);
            }
            
            const { swapTransaction } = await swapResponse.json();
            
            if (!swapTransaction) {
                throw new Error('Pas de transaction reçue de Jupiter');
            }
            
            // Désérialiser et signer la transaction
            const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
            const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
            
            // Signer la transaction
            transaction.sign([this.wallet]);
            
            console.log(`📤 Envoi de la transaction...`);
            
            // Envoyer la transaction avec retry
            let txid = null;
            let attempts = 0;
            const maxAttempts = 3;
            
            while (attempts < maxAttempts && !txid) {
                try {
                    attempts++;
                    console.log(`   Tentative ${attempts}/${maxAttempts}...`);
                    
                    txid = await this.connection.sendTransaction(transaction, {
                        preflightCommitment: 'confirmed',
                        maxRetries: 0, // Pas de retry automatique
                        skipPreflight: false // Garder la simulation
                    });
                    
                    if (txid) {
                        console.log(`✅ Transaction envoyée: ${txid}`);
                        break;
                    }
                } catch (sendError) {
                    console.log(`❌ Tentative ${attempts} échouée: ${sendError.message}`);
                    
                    // Si erreur de simulation, arrêter immédiatement
                    if (sendError.message.includes('simulation failed') || 
                        sendError.message.includes('insufficient funds')) {
                        console.log(`🛑 Erreur fatale détectée, arrêt des tentatives`);
                        throw sendError;
                    }
                    
                    // Attendre avant retry
                    if (attempts < maxAttempts) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                }
            }
            
            if (!txid) {
                throw new Error(`Impossible d'envoyer la transaction après ${maxAttempts} tentatives`);
            }
            
            // Attendre la confirmation avec timeout
            console.log(`⏳ Attente confirmation...`);
            const confirmationStart = Date.now();
            const confirmationTimeout = 60000; // 60 secondes
            
            console.log(`⏳ Confirmation par polling...`);
const confirmed = await this.confirmTransactionPolling(txid);

if (confirmed) {
    console.log(`✅ Transaction confirmée: ${txid}`);
    return txid;
} else {
    console.log(`⚠️ Confirmation timeout, mais transaction peut être valide: ${txid}`);
    return txid;
}
            
        } catch (error) {
            console.error(`❌ Erreur swap détaillée: ${error.message}`);
            
            // Logging détaillé pour debug
            if (error.message.includes('simulation failed')) {
                console.error('🔍 Erreur de simulation - vérifiez:');
                console.error('   - Solde suffisant du wallet');
                console.error('   - Token account existe');
                console.error('   - Slippage pas trop restrictif');
                console.error('   - Pool avec liquidité suffisante');
            }
            
            return null;
        }
    }

    // Acheter un token
    async buyToken(tokenAddress, tokenData) {
        try {
            console.log(`💰 Tentative d'achat: ${tokenData.baseToken.symbol}`);
            
            const solAmount = this.buyAmount * 1e9; // Convertir en lamports
            const solMint = 'So11111111111111111111111111111111111111112';
            
            // Obtenir quote d'achat
            const buyQuote = await this.getJupiterQuote(solMint, tokenAddress, solAmount);
            
            if (!buyQuote) {
                console.log(`❌ Impossible d'obtenir quote pour ${tokenData.baseToken.symbol}`);
                return false;
            }
            
            // Exécuter l'achat
            const txid = await this.executeSwap(buyQuote);
            
            if (txid) {
                const tokenAmount = parseFloat(buyQuote.outAmount);
                const price = parseFloat(tokenData.priceUsd || 0);
                
                // Enregistrer la position
                const position = {
                    tokenAddress,
                    symbol: tokenData.baseToken.symbol,
                    buyPrice: price,
                    buyAmount: tokenAmount,
                    currentAmount: tokenAmount, // Pour tracking des ventes partielles
                    buyTxid: txid,
                    buyTime: Date.now(),
                    solSpent: this.buyAmount,
                    sellsExecuted: [], // Tracking des niveaux de vente déjà exécutés
                    totalSolReceived: 0, // Total SOL reçu des ventes partielles
                    partialSells: 0, // Nombre de ventes partielles
                    highestPrice: price, // Plus haut prix atteint (pour trailing stop)
                    highestPercent: 0 // Plus haut pourcentage atteint
                };
                
                this.positions.set(tokenAddress, position);
                
                console.log(`✅ Achat réussi: ${tokenData.baseToken.symbol}`);
                console.log(`   💰 Prix: $${price}`);
                console.log(`   🪙 Quantité: ${tokenAmount.toLocaleString()}`);
                console.log(`   🔗 TX: ${txid}`);
                
                // Notification Discord
                await this.notifyBuy(position, tokenData);
                
                return true;
            }
            
            return false;
        } catch (error) {
            console.error(`❌ Erreur achat ${tokenData.baseToken?.symbol}: ${error.message}`);
            return false;
        }
    }

    // Vérifier les positions avec ventes échelonnées (toutes les minutes)
    async checkPositions() {
        if (this.positions.size === 0) return;
        
        console.log(`📊 Vérification de ${this.positions.size} positions...`);
        
        for (const [tokenAddress, position] of this.positions.entries()) {
            try {
                // Obtenir le prix actuel via DexScreener
                const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
                
                if (response.ok) {
                    const data = await response.json();
                    const pair = data.pairs?.find(p => p.chainId === 'solana');
                    
                    if (pair) {
                        const currentPrice = parseFloat(pair.priceUsd || 0);
                        const changePercent = ((currentPrice / position.buyPrice) - 1) * 100;
                        
                        // Mettre à jour le plus haut prix atteint
                        if (!position.highestPrice || currentPrice > position.highestPrice) {
                            position.highestPrice = currentPrice;
                            position.highestPercent = changePercent;
                        }
                        
                        console.log(`   📈 ${position.symbol}: ${changePercent > 0 ? '+' : ''}${changePercent.toFixed(1)}% (Max: +${position.highestPercent?.toFixed(1) || 0}%)`);
                        
                        // Vérifier stop-loss classique
                        if (changePercent <= -this.stopLossPercent) {
                            await this.sellEntirePosition(position, currentPrice, `Stop-Loss (-${this.stopLossPercent}%)`);
                            continue;
                        }
                        
                        // Vérifier trailing stop
                        if (this.useTrailingStop && position.highestPrice) {
                            const drawdownFromHigh = ((position.highestPrice - currentPrice) / position.highestPrice) * 100;
                            if (drawdownFromHigh >= this.trailingStopPercent) {
                                await this.sellEntirePosition(position, currentPrice, `Trailing Stop (-${drawdownFromHigh.toFixed(1)}% depuis le max)`);
                                continue;
                            }
                        }
                        
                        // Vérifier les niveaux de vente échelonnée
                        await this.checkStagedSells(position, changePercent, currentPrice);
                    }
                }
                
                // Rate limiting
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                console.log(`⚠️ Erreur vérification ${position.symbol}: ${error.message}`);
            }
        }
    }

    // Vérifier et exécuter les ventes échelonnées
    async checkStagedSells(position, changePercent, currentPrice) {
        // Vérifier chaque niveau de vente
        for (const level of this.sellLevels) {
            // Si on a atteint ce niveau et qu'on ne l'a pas encore exécuté
            if (changePercent >= level.profit && !position.sellsExecuted.includes(level.profit)) {
                
                // Calculer la quantité à vendre
                const remainingAmount = position.currentAmount;
                const amountToSell = remainingAmount * (level.percentage / 100);
                
                if (amountToSell > 0) {
                    console.log(`🎯 Déclenchement vente échelonnée: ${position.symbol} +${changePercent.toFixed(1)}%`);
                    console.log(`   💰 Vendre ${level.percentage}% (${amountToSell.toLocaleString()} tokens)`);
                    
                    const success = await this.sellPartialPosition(position, amountToSell, level, currentPrice);
                    
                    if (success) {
                        // Marquer ce niveau comme exécuté
                        position.sellsExecuted.push(level.profit);
                        
                        // Mettre à jour la quantité restante
                        position.currentAmount = remainingAmount - amountToSell;
                        
                        // Si on a vendu tout, supprimer la position
                        if (position.currentAmount <= position.buyAmount * 0.01) { // Moins de 1% restant
                            console.log(`✅ Position ${position.symbol} entièrement vendue`);
                            this.positions.delete(position.tokenAddress);
                            break;
                        }
                    }
                }
            }
        }
    }

    // Vendre une partie de la position avec vérifications renforcées
    async sellPartialPosition(position, amountToSell, level, currentPrice) {
        try {
            console.log(`💸 Vente partielle: ${position.symbol} (${level.reason})`);
            console.log(`   🪙 Quantité à vendre: ${amountToSell.toLocaleString()}`);
            
            const tokenMint = position.tokenAddress;
            const solMint = 'So11111111111111111111111111111111111111112';
            
            // Arrondir la quantité pour éviter les erreurs de précision
            const roundedAmount = Math.floor(amountToSell);
            
            if (roundedAmount <= 0) {
                console.log(`❌ Quantité arrondie trop petite: ${roundedAmount}`);
                return false;
            }
            
            console.log(`   📊 Quantité arrondie: ${roundedAmount.toLocaleString()}`);
            
            // Vérifier qu'on a assez de tokens
            const hasTokens = await this.checkWalletBalance(tokenMint, roundedAmount);
            if (!hasTokens) {
                console.log(`❌ Pas assez de tokens pour la vente partielle`);
                return false;
            }
            
            // Obtenir quote de vente pour la quantité partielle
            const sellQuote = await this.getJupiterQuote(tokenMint, solMint, roundedAmount);
            
            if (!sellQuote) {
                console.log(`❌ Impossible d'obtenir quote de vente partielle pour ${position.symbol}`);
                return false;
            }
            
            console.log(`   💰 Quote reçu: ${roundedAmount} tokens → ${(parseFloat(sellQuote.outAmount) / 1e9).toFixed(4)} SOL`);
            
            // Exécuter la vente
            const txid = await this.executeSwap(sellQuote);
            
            if (txid) {
                const solReceived = parseFloat(sellQuote.outAmount) / 1e9;
                const partialProfit = solReceived - (position.solSpent * (level.percentage / 100));
                const partialProfitPercent = ((currentPrice / position.buyPrice) - 1) * 100;
                
                console.log(`✅ Vente partielle réussie: ${position.symbol}`);
                console.log(`   💰 SOL reçu: ${solReceived.toFixed(4)}`);
                console.log(`   📊 Profit partiel: ${partialProfit > 0 ? '+' : ''}${partialProfit.toFixed(4)} SOL`);
                console.log(`   🔗 TX: ${txid}`);
                
                // Notification Discord pour vente partielle
                await this.notifyPartialSell(position, solReceived, partialProfit, partialProfitPercent, level, txid);
                
                // Mettre à jour les statistiques de la position
                position.totalSolReceived += solReceived;
                position.partialSells += 1;
                
                return true;
            }
            
            return false;
        } catch (error) {
            console.error(`❌ Erreur vente partielle ${position.symbol}: ${error.message}`);
            return false;
        }
    }

    // Vendre toute la position restante avec vérifications renforcées
    async sellEntirePosition(position, currentPrice, reason) {
        try {
            console.log(`💸 Vente totale: ${position.symbol} (${reason})`);
            
            const tokenMint = position.tokenAddress;
            const solMint = 'So11111111111111111111111111111111111111112';
            
            // Obtenir le solde réel du wallet pour ce token
            const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                this.wallet.publicKey,
                { mint: new PublicKey(tokenMint) }
            );
            
            if (tokenAccounts.value.length === 0) {
                console.log(`❌ Aucun compte token trouvé pour vente totale`);
                return false;
            }
            
            const realBalance = parseFloat(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
            const amountToSell = Math.floor(realBalance * 0.99); // Garder 1% pour éviter les erreurs d'arrondi
            
            console.log(`   🪙 Solde réel: ${realBalance.toLocaleString()}`);
            console.log(`   🪙 Quantité à vendre: ${amountToSell.toLocaleString()}`);
            
            if (amountToSell <= 0) {
                console.log(`❌ Pas de tokens à vendre`);
                return false;
            }
            
            // Obtenir quote de vente pour tout le restant
            const sellQuote = await this.getJupiterQuote(tokenMint, solMint, amountToSell);
            
            if (!sellQuote) {
                console.log(`❌ Impossible d'obtenir quote de vente totale pour ${position.symbol}`);
                return false;
            }
            
            console.log(`   💰 Quote reçu: ${amountToSell} tokens → ${(parseFloat(sellQuote.outAmount) / 1e9).toFixed(4)} SOL`);
            
            // Exécuter la vente
            const txid = await this.executeSwap(sellQuote);
            
            if (txid) {
                const solReceived = parseFloat(sellQuote.outAmount) / 1e9;
                const totalSolReceived = position.totalSolReceived + solReceived;
                const totalProfit = totalSolReceived - position.solSpent;
                const totalProfitPercent = ((totalSolReceived / position.solSpent) - 1) * 100;
                
                console.log(`✅ Vente totale réussie: ${position.symbol}`);
                console.log(`   💰 SOL total reçu: ${totalSolReceived.toFixed(4)}`);
                console.log(`   📊 Profit total: ${totalProfit > 0 ? '+' : ''}${totalProfit.toFixed(4)} SOL (${totalProfitPercent > 0 ? '+' : ''}${totalProfitPercent.toFixed(1)}%)`);
                console.log(`   🔗 TX: ${txid}`);
                
                // Notification Discord pour vente finale
                await this.notifyFinalSell(position, totalSolReceived, totalProfit, totalProfitPercent, reason, txid);
                
                // Supprimer la position
                this.positions.delete(position.tokenAddress);
                
                return true;
            }
            
            return false;
        } catch (error) {
            console.error(`❌ Erreur vente totale ${position.symbol}: ${error.message}`);
            return false;
        }
    }

    // Notification Discord d'achat
    async notifyBuy(position, tokenData) {
        try {
            const channel = await this.client.channels.fetch(this.channelId);
            if (!channel) return;
            
            const embed = new EmbedBuilder()
                .setColor(0x00ff00)
                .setTitle(`🛒 ACHAT AUTOMATIQUE - ${position.symbol}`)
                .setDescription(`**Auto-trader a acheté ${tokenData.baseToken.name}**`)
                .addFields(
                    {
                        name: '💰 Prix d\'achat',
                        value: `$${position.buyPrice.toFixed(6)}`,
                        inline: true
                    },
                    {
                        name: '🪙 Quantité',
                        value: position.buyAmount.toLocaleString(),
                        inline: true
                    },
                    {
                        name: '💎 SOL dépensé',
                        value: `${position.solSpent} SOL`,
                        inline: true
                    },
                    {
                        name: '🎯 Ventes échelonnées',
                        value: `+25% (40%), +75% (60%), +200% (75%), +500% (90%)`,
                        inline: false
                    },
                    {
                        name: '🛡️ Protections',
                        value: `📉 Stop-Loss: -${this.stopLossPercent}%\n📈 Trailing: -${this.trailingStopPercent}%`,
                        inline: false
                    },
                    {
                        name: '📍 Adresse',
                        value: `\`${position.tokenAddress}\``,
                        inline: false
                    },
                    {
                        name: '🔗 Liens',
                        value: `[📊 DexScreener](${tokenData.url}) | [🔍 Solscan](https://solscan.io/tx/${position.buyTxid})`,
                        inline: false
                    }
                )
                .setFooter({ text: `Achat à ${new Date().toLocaleTimeString()}` })
                .setTimestamp();
            
            await channel.send({
                content: `🚨 **ACHAT AUTO** 🚨\n${position.symbol} acheté pour ${position.solSpent} SOL`,
                embeds: [embed]
            });
            
        } catch (error) {
            console.error('❌ Erreur notification achat:', error.message);
        }
    }

    // Notification Discord pour vente partielle
    async notifyPartialSell(position, solReceived, profit, profitPercent, level, txid) {
        try {
            const channel = await this.client.channels.fetch(this.channelId);
            if (!channel) return;
            
            const embed = new EmbedBuilder()
                .setColor(0x00ff00)
                .setTitle(`💰 VENTE PARTIELLE - ${position.symbol}`)
                .setDescription(`**${level.reason}** - ${level.percentage}% vendu`)
                .addFields(
                    {
                        name: '💰 SOL reçu (partiel)',
                        value: `${solReceived.toFixed(4)} SOL`,
                        inline: true
                    },
                    {
                        name: '📈 Performance',
                        value: `+${profitPercent.toFixed(1)}%`,
                        inline: true
                    },
                    {
                        name: '🪙 Restant',
                        value: `${(100 - level.percentage).toFixed(0)}%`,
                        inline: true
                    },
                    {
                        name: '📊 Ventes effectuées',
                        value: `${position.partialSells + 1} niveaux`,
                        inline: true
                    },
                    {
                        name: '⏱️ Durée position',
                        value: `${((Date.now() - position.buyTime) / (1000 * 60)).toFixed(0)} min`,
                        inline: true
                    },
                    {
                        name: '🔗 Transaction',
                        value: `[🔍 Solscan](https://solscan.io/tx/${txid})`,
                        inline: false
                    }
                )
                .setFooter({ text: `Vente partielle à ${new Date().toLocaleTimeString()}` })
                .setTimestamp();
            
            await channel.send({
                content: `💰 **VENTE PARTIELLE** 💰\n${position.symbol}: ${level.percentage}% vendu à +${profitPercent.toFixed(1)}%`,
                embeds: [embed]
            });
            
        } catch (error) {
            console.error('❌ Erreur notification vente partielle:', error.message);
        }
    }

    // Notification Discord pour vente finale
    async notifyFinalSell(position, totalSolReceived, totalProfit, totalProfitPercent, reason, txid) {
        try {
            const channel = await this.client.channels.fetch(this.channelId);
            if (!channel) return;
            
            const isProfit = totalProfit > 0;
            const color = isProfit ? 0x00ff00 : 0xff0000;
            const emoji = isProfit ? '🎉' : '😢';
            
            const embed = new EmbedBuilder()
                .setColor(color)
                .setTitle(`🏁 POSITION FERMÉE - ${position.symbol}`)
                .setDescription(`**${reason}**`)
                .addFields(
                    {
                        name: '💰 SOL total reçu',
                        value: `${totalSolReceived.toFixed(4)} SOL`,
                        inline: true
                    },
                    {
                        name: `${emoji} Profit/Perte total`,
                        value: `${totalProfit > 0 ? '+' : ''}${totalProfit.toFixed(4)} SOL`,
                        inline: true
                    },
                    {
                        name: '📊 Performance totale',
                        value: `${totalProfitPercent > 0 ? '+' : ''}${totalProfitPercent.toFixed(1)}%`,
                        inline: true
                    },
                    {
                        name: '🎯 Ventes échelonnées',
                        value: `${position.partialSells} niveaux + finale`,
                        inline: true
                    },
                    {
                        name: '📈 Plus haut atteint',
                        value: `+${position.highestPercent.toFixed(1)}%`,
                        inline: true
                    },
                    {
                        name: '⏱️ Durée totale',
                        value: `${((Date.now() - position.buyTime) / (1000 * 60)).toFixed(0)} minutes`,
                        inline: true
                    },
                    {
                        name: '🔗 Transaction finale',
                        value: `[🔍 Solscan](https://solscan.io/tx/${txid})`,
                        inline: false
                    }
                )
                .setFooter({ text: `Position fermée à ${new Date().toLocaleTimeString()}` })
                .setTimestamp();
            
            await channel.send({
                content: `${isProfit ? '🎉' : '😢'} **POSITION FERMÉE** ${isProfit ? '🎉' : '😢'}\n${position.symbol}: ${totalProfitPercent > 0 ? '+' : ''}${totalProfitPercent.toFixed(1)}% total`,
                embeds: [embed]
            });
            
        } catch (error) {
            console.error('❌ Erreur notification vente finale:', error.message);
        }
    }

    // Traiter les nouveaux tokens
    async processNewTokens(tokens) {
        console.log(`🔄 Traitement de ${tokens.length} nouveaux tokens...`);
        
        let boughtCount = 0;
        
        for (const tokenData of tokens) {
            try {
                const tokenAddress = tokenData.baseToken?.address;
                if (!tokenAddress) continue;
                
                // Éviter les doublons
                if (this.isTokenAlreadyProcessed(tokenAddress)) {
                    console.log(`⏭️ Token déjà traité: ${tokenData.baseToken.symbol}`);
                    continue;
                }
                
                // Éviter d'acheter si on a déjà une position
                if (this.positions.has(tokenAddress)) {
                    console.log(`⏭️ Position déjà ouverte: ${tokenData.baseToken.symbol}`);
                    continue;
                }
                
                // Tentative d'achat
                const bought = await this.buyToken(tokenAddress, tokenData);
                
                if (bought) {
                    this.markTokenAsProcessed(tokenAddress);
                    boughtCount++;
                    
                    // Limiter les achats par scan
                    if (boughtCount >= 2) {
                        console.log('⚠️ Limite d\'achats par scan atteinte');
                        break;
                    }
                } else {
                    console.log(`❌ Échec achat: ${tokenData.baseToken.symbol}`);
                }
                
                // Rate limiting
                await new Promise(resolve => setTimeout(resolve, 3000));
                
            } catch (error) {
                console.error(`❌ Erreur traitement token: ${error.message}`);
            }
        }
        
        console.log(`✅ ${boughtCount} tokens achetés`);
        return boughtCount;
    }

    // Fonction principale de scan et trading
    async runTradingCycle() {
        console.log('\n🤖 CYCLE DE TRADING AUTO');
        console.log('═'.repeat(50));
        
        try {
            // 1. Vérifier les positions existantes CHAQUE MINUTE
            if (this.positions.size > 0) {
                await this.checkPositions();
            }
            
            // 2. Scanner les nouveaux tokens (moins fréquent)
            const tokens = await this.scanNewTokens();
            
            if (tokens.length > 0) {
                // 3. Traiter les nouveaux tokens
                await this.processNewTokens(tokens);
            } else {
                console.log('⚠️ Aucun nouveau token trouvé');
            }
            
            // 4. Statistiques
            console.log(`\n📊 Positions actives: ${this.positions.size}`);
            if (this.positions.size > 0) {
                for (const [, position] of this.positions) {
                    const duration = ((Date.now() - position.buyTime) / (1000 * 60)).toFixed(0);
                    const profit = ((position.totalSolReceived + (position.currentAmount / position.buyAmount * position.solSpent)) / position.solSpent - 1) * 100;
                    console.log(`   💎 ${position.symbol}: ${duration}min, ${profit > 0 ? '+' : ''}${profit.toFixed(1)}%, ${position.partialSells} ventes`);
                }
            }
            
            return true;
            
        } catch (error) {
            console.error('❌ Erreur cycle trading:', error.message);
            return false;
        }
    }

    // Lancer le trading automatique avec double timing
    async startAutoTrading() {
        console.log(`🚀 Démarrage Auto-Trading avec ventes échelonnées`);
        console.log(`💼 Wallet: ${this.wallet.publicKey.toString()}`);
        console.log(`💰 Montant par achat: ${this.buyAmount} SOL`);
        console.log(`🎯 Ventes échelonnées: +25%(40%), +75%(60%), +200%(75%), +500%(90%)`);
        console.log(`📉 Stop-Loss: -${this.stopLossPercent}%`);
        console.log(`📈 Trailing Stop: -${this.trailingStopPercent}%`);
        console.log(`⏰ Check positions: Toutes les minutes`);
        console.log(`🔍 Scan nouveaux tokens: Toutes les 5 minutes`);
        console.log('💡 Appuyez sur Ctrl+C pour arrêter\n');
        
        let cycleCount = 0;
        let scanCount = 0;
        
        // Timer pour vérifier les positions toutes les 2 minutes (au lieu de 1)
        const positionCheckTimer = setInterval(async () => {
            try {
                if (this.positions.size > 0) {
                    console.log(`\n⏰ ${new Date().toLocaleTimeString()} - Check positions`);
                    await this.checkPositions();
                }
            } catch (error) {
                console.error('❌ Erreur check positions:', error.message);
            }
        }, 2 * 60 * 1000); // 2 minutes au lieu de 1
        
        // Timer pour scanner nouveaux tokens toutes les 10 minutes (au lieu de 5)
        const scanTimer = setInterval(async () => {
            try {
                scanCount++;
                console.log(`\n⏰ ${new Date().toLocaleTimeString()} - Scan nouveaux tokens #${scanCount}`);
                
                const tokens = await this.scanNewTokens();
                if (tokens.length > 0) {
                    await this.processNewTokens(tokens);
                }
                
                // Statistiques
                console.log(`📊 Positions actives: ${this.positions.size}`);
                if (this.positions.size > 0) {
                    for (const [, position] of this.positions) {
                        const duration = ((Date.now() - position.buyTime) / (1000 * 60)).toFixed(0);
                        console.log(`   💎 ${position.symbol}: ${duration}min, ${position.partialSells} ventes partielles`);
                    }
                }
                
            } catch (error) {
                console.error('❌ Erreur scan:', error.message);
            }
        }, 10 * 60 * 1000); // 10 minutes au lieu de 5
        
        // Scan initial immédiat
        try {
            console.log(`\n⏰ ${new Date().toLocaleString()} - Scan initial`);
            const tokens = await this.scanNewTokens();
            if (tokens.length > 0) {
                await this.processNewTokens(tokens);
            }
        } catch (error) {
            console.error('❌ Erreur scan initial:', error.message);
        }
        
        // Garder le processus en vie
        process.on('SIGINT', () => {
            console.log('\n🛑 Arrêt du trader...');
            clearInterval(positionCheckTimer);
            clearInterval(scanTimer);
            process.exit(0);
        });
        
        // Boucle infinie pour garder le processus actif
        while (true) {
            await new Promise(resolve => setTimeout(resolve, 60000));
        }
    }
}

// Fonctions d'utilisation
async function runAutoTrader() {
    console.log('🤖 Auto-Trader Jupiter - Ventes Échelonnées');
    console.log('═'.repeat(60));
    
    const trader = new SimpleAutoTrader();
    
    try {
        // Initialiser Discord
        const isConnected = await trader.initializeDiscord();
        if (!isConnected) {
            console.log('❌ Impossible de se connecter à Discord');
            return;
        }
        
        // Attendre la connexion
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Vérifier le solde
        const balance = await trader.connection.getBalance(trader.wallet.publicKey);
        const solBalance = balance / 1e9;
        
        console.log(`💰 Solde wallet: ${solBalance.toFixed(4)} SOL`);
        
        if (solBalance < trader.buyAmount * 2) {
            console.log(`⚠️ Solde insuffisant pour trader (minimum: ${trader.buyAmount * 2} SOL)`);
            return;
        }
        
        // Lancer l'auto-trading avec double timing
        await trader.startAutoTrading();
        
    } catch (error) {
        console.error('❌ Erreur:', error.message);
    }
}

async function testTrader() {
    console.log('🧪 Test Auto-Trader...');
    
    const trader = new SimpleAutoTrader();
    
    try {
        // Test connexions
        await trader.initializeDiscord();
        console.log('✅ Discord OK');
        
        const balance = await trader.connection.getBalance(trader.wallet.publicKey);
        console.log(`✅ Solana OK - Balance: ${(balance / 1e9).toFixed(4)} SOL`);
        
        // Test scan
        const tokens = await trader.scanNewTokens();
        console.log(`✅ Scan OK - ${tokens.length} tokens trouvés`);
        
        console.log('\n🎯 Configuration ventes échelonnées:');
        trader.sellLevels.forEach((level, i) => {
            console.log(`   ${i + 1}. +${level.profit}% → Vendre ${level.percentage}% (${level.reason})`);
        });
        
        console.log(`\n🛡️ Protections:`);
        console.log(`   📉 Stop-Loss: -${trader.stopLossPercent}%`);
        console.log(`   📈 Trailing Stop: -${trader.trailingStopPercent}%`);
        console.log(`   ⏰ Check positions: Toutes les minutes`);
        console.log(`   🔍 Scan tokens: Toutes les 5 minutes`);
        
        console.log('\n🎉 Tous les tests réussis !');
        
    } catch (error) {
        console.error('❌ Erreur test:', error.message);
    }
}

module.exports = { SimpleAutoTrader, runAutoTrader, testTrader };

// Exécution si lancé directement
if (require.main === module) {
    const args = process.argv.slice(2);
    
    if (args.includes('--test')) {
        testTrader();
    } else {
        console.log('🎯 Auto-Trader Jupiter - Ventes Échelonnées');
        console.log('═'.repeat(50));
        console.log('Usage:');
        console.log('  node simple_auto_trader.js         - Lancer auto-trading');
        console.log('  node simple_auto_trader.js --test  - Tester config');
        console.log('');
        console.log('Variables .env requises:');
        console.log('  DISCORD_TOKEN=...');
        console.log('  DISCORD_CHANNEL_ID=...');
        console.log('  PRIVATE_KEY=... (clé privée wallet base58)');
        console.log('  BUY_AMOUNT_SOL=0.01 (optionnel)');
        console.log('  MAX_SLIPPAGE=10 (optionnel)');
        console.log('');
        console.log('🎯 Stratégie ventes échelonnées:');
        console.log('  +25%  → Vendre 40% (sécurisation rapide)');
        console.log('  +75%  → Vendre 60% du restant');
        console.log('  +200% → Vendre 75% du restant');
        console.log('  +500% → Vendre 90% du restant');
        console.log('  Stop-Loss: -20% | Trailing: -15%');
        console.log('');
        
        runAutoTrader();
    }
}
// À la toute fin du fichier, après le module.exports
// Serveur web simple pour satisfaire Render
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// Route de santé
app.get('/', (req, res) => {
    res.json({
        status: 'Bot Jupiter Scanner actif! 🚀',
        uptime: process.uptime(),
        lastScan: new Date().toISOString()
    });
});

// Statistiques du bot
app.get('/stats', (req, res) => {
    res.json({
        bot: 'Jupiter Scanner',
        status: 'running',
        scans: 'Toutes les 15 minutes'
    });
});

// Démarrer le serveur
app.listen(port, '0.0.0.0', () => {
    console.log(`🌐 Serveur web actif sur port ${port}`);
});