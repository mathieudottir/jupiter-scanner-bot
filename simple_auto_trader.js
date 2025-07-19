
    // simple_auto_trader.js - Auto-trader Jupiter avec whitelist DexScreener
require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { Connection, Keypair, PublicKey, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const express = require('express');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class SimpleAutoTrader {
    constructor() {
        // Configuration Discord
        this.discordToken = process.env.DISCORD_TOKEN;
        this.channelId = process.env.DISCORD_CHANNEL_ID;
        this.client = new Client({ 
            intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] 
        });
        
        // Configuration Solana avec RPC sécurisé
        const rpcUrls = [
            'https://api.mainnet-beta.solana.com',
            'https://rpc.ankr.com/solana',
            'https://solana-api.projectserum.com',
            process.env.SOLANA_RPC_URL
        ].filter(url => url && !url.includes('undefined'));
        
        this.connection = new Connection(rpcUrls[0] || 'https://api.mainnet-beta.solana.com', {
            commitment: 'confirmed',
            wsEndpoint: false,
            httpHeaders: { 'User-Agent': 'Jupiter-Trader/1.0' }
        });

        this.backupConnections = rpcUrls.slice(1).map(url => 
            new Connection(url, { 
                commitment: 'confirmed',
                wsEndpoint: false
            })
        );

        // Configuration wallet et trading
        this.wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
        this.buyAmount = 0.01; // 0.01 SOL par achat
        this.maxSlippage = parseFloat(process.env.MAX_SLIPPAGE || '10');
        this.maxConcurrentPositions = 5;

        // WHITELIST - Chargement depuis fichier
        this.whitelistedTokens = {};
        this.whitelistPath = './whitelist.json';
        this.loadWhitelist();

        
        // Configuration whitelist PLUS FLEXIBLE pour trouver des trades
        // Configuration whitelist OPTIMISÉE
                this.whitelistMode = {
            enabled: true,
            allowOnlyWhitelisted: true,
            minMomentum1h: 0,        // 0% sur 1h (accepter stabilité)
            minMomentum24h: 2,       // +2% sur 24h (légèrement positif)
            minVolume: 100000,       // $100k volume (plus réaliste)
            debugMode: true
        };

        // Système de cooldown PLUS SMART
        this.retradeCooldown = {
    normal: 24 * 60 * 60 * 1000,        // 24h normal
    afterLoss: 36 * 60 * 60 * 1000,     // 36h si perte (au lieu de 48h)
    afterProfit: 8 * 60 * 60 * 1000,    // 8h si profit (au lieu de 12h)
    opportunityThreshold: 40,             // +40% momentum pour override (au lieu de 50%)
    minCooldownOverride: 6 * 60 * 60 * 1000  // Min 6h avant override
};
        // STATISTIQUES DE PERFORMANCE
        this.stats = {
            allTime: {
                totalTrades: 0,
                wins: 0,
                losses: 0,
                totalProfitSOL: 0,
                totalInvestedSOL: 0,
                bestTrade: { symbol: 'N/A', profit: 0 },
                worstTrade: { symbol: 'N/A', profit: 0 },
                avgHoldTime: 0,
                totalHoldTime: 0
            },
            daily: {
                date: new Date().toDateString(),
                trades: 0,
                wins: 0,
                losses: 0,
                profitSOL: 0,
                investedSOL: 0
            },
            hourly: {
                hour: new Date().getHours(),
                trades: 0,
                wins: 0,
                losses: 0,
                profitSOL: 0
            },
            session: {
                startTime: Date.now(),
                trades: 0,
                wins: 0,
                losses: 0,
                profitSOL: 0,
                investedSOL: 0
            }
        };

        // Configuration ventes échelonnées
        // VENTES PLUS AGRESSIVES
        this.sellLevels = [
            { profit: 12, percentage: 35, reason: "Sécurisation rapide (+12%)" },
            { profit: 30, percentage: 45, reason: "Profit solide (+30%)" },
            { profit: 60, percentage: 65, reason: "Gros profit (+60%)" },
            { profit: 120, percentage: 85, reason: "Moonshot (+120%)" }
        ];

        // Protections stop-loss et trailing
        this.stopLossPercent = 10; // -10%
        this.useTrailingStop = true;
        this.trailingStopPercent = 9; // 9% depuis le plus haut

        // Sortie par stagnation
        this.stagnationExit = {
            enabled: true,
            maxHoldTime: 4 * 60 * 60 * 1000,    // 4 heures maximum
            stagnantTime: 2 * 60 * 60 * 1000,   // 2h si stagnant
            stagnantThreshold: 5,                // ±5% = stagnant
            lossExitTime: 90 * 60 * 1000,       // 1h30 si perte
            lossThreshold: -10                   // -10%
        };

        

        // État du trader
        this.positions = new Map(); // tokenAddress -> position data
        this.tradedTokens = new Map(); // tokenAddress -> tradeHistory pour cooldown
        this.bannedAddresses = new Set();
        
        // Rate limiting et cache
        this.lastRpcCall = 0;
        this.rpcCallDelay = 2000;
        this.balanceCache = new Map();
        this.cacheTimeout = 60000;

        // Charger adresses bannies
        this.loadBannedAddresses();

        console.log(`💼 Wallet: ${this.wallet.publicKey.toString()}`);
        console.log(`🛡️ Whitelist: ${Object.keys(this.whitelistedTokens).length} tokens`);
        console.log(`💰 Montant par achat: ${this.buyAmount} SOL`);
        console.log(`🎯 Ventes échelonnées: ${this.sellLevels.length} niveaux`);
        console.log(`📉 Stop loss: -${this.stopLossPercent}%`);
        console.log(`📈 Trailing stop: -${this.trailingStopPercent}%`);
    }

    // CHARGEMENT DE LA WHITELIST - FORMAT CORRECT POUR VOTRE FICHIER
    loadWhitelist() {
        try {
            const fs = require('fs');
            
            if (fs.existsSync(this.whitelistPath)) {
                const whitelistData = JSON.parse(fs.readFileSync(this.whitelistPath, 'utf8'));
                
                // Votre format: whitelistData.tokens.SYMBOL.address
                for (const [symbol, data] of Object.entries(whitelistData.tokens)) {
                    if (data.verified && data.address) {
                        this.whitelistedTokens[symbol] = data.address;
                    }
                }
                
                console.log(`✅ Whitelist VOTRE FICHIER chargée: v${whitelistData.metadata?.version || 'N/A'}`);
                console.log(`📊 ${Object.keys(this.whitelistedTokens).length} tokens vérifiés de votre whitelist`);
                console.log(`🎯 Tokens chargés: ${Object.keys(this.whitelistedTokens).join(', ')}`);
                
                // Vérification spéciale pour HNT
                if (this.whitelistedTokens.HNT) {
                    console.log(`🔍 HNT trouvé: ${this.whitelistedTokens.HNT}`);
                    console.log(`   📝 Nom: ${whitelistData.tokens.HNT.name}`);
                    console.log(`   📂 Catégorie: ${whitelistData.tokens.HNT.category}`);
                    console.log(`   ✅ Vérifié: ${whitelistData.tokens.HNT.verified}`);
                } else {
                    console.log(`❌ HNT non trouvé dans la whitelist !`);
                }
                
            } else {
                console.log(`❌ ERREUR: Fichier whitelist INTROUVABLE: ${this.whitelistPath}`);
                console.log(`📝 Le bot ne peut fonctionner SANS votre whitelist !`);
                console.log(`💡 Créez le fichier whitelist.json avec vos tokens vérifiés`);
                
                throw new Error('Whitelist fichier requis !');
            }
            
        } catch (error) {
            console.error(`❌ Erreur chargement whitelist: ${error.message}`);
            console.log(`🛑 Bot arrêté - whitelist.json requis`);
            process.exit(1);
        }
    }

    createBasicWhitelist() {
        // Whitelist CORRIGÉE avec adresses VÉRIFIÉES Solana
        this.whitelistedTokens = {
            // Meme coins populaires - ADRESSES VÉRIFIÉES
            'BONK': 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
            'WIF': 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', 
            'PEPE': 'BzUb1pc3GKZD1DbLhKpuzWJCPBdSFGSqhfFGBCSDhyPR',  // À vérifier
            'POPCAT': '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
            
            // Tokens DeFi confirmés
            'JUP': 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
            'RAY': '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
            'ORCA': 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
            
            // Stablecoins et wrappés
            'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            'USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
            'MSOL': 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'
        };
        
        console.log(`📝 Whitelist CORRIGÉE avec ${Object.keys(this.whitelistedTokens).length} tokens vérifiés`);
        console.log(`✅ Adresses vérifiées pour éviter erreurs de route`);
    }

    // GESTION DES ADRESSES BANNIES
    loadBannedAddresses() {
        try {
            const fs = require('fs');
            if (fs.existsSync('./banned_addresses.txt')) {
                const content = fs.readFileSync('./banned_addresses.txt', 'utf8');
                const addresses = content.split('\n')
                    .map(addr => addr.trim())
                    .filter(addr => addr && !addr.startsWith('#'));
                
                addresses.forEach(addr => this.bannedAddresses.add(addr));
                console.log(`🚫 ${addresses.length} adresses bannies chargées`);
            }
        } catch (error) {
            console.log('⚠️ Erreur chargement banned_addresses.txt:', error.message);
        }
    }

    isAddressBanned(tokenAddress) {
        return this.bannedAddresses.has(tokenAddress);
    }

    banAddress(tokenAddress, reason = 'Manual ban') {
        this.bannedAddresses.add(tokenAddress);
        console.log(`🚫 Adresse bannie: ${tokenAddress} (${reason})`);
        this.saveBannedAddresses();
    }

    saveBannedAddresses() {
        try {
            const fs = require('fs');
            const content = Array.from(this.bannedAddresses).join('\n');
            fs.writeFileSync('./banned_addresses.txt', content);
        } catch (error) {
            console.log('⚠️ Erreur sauvegarde banned_addresses.txt:', error.message);
        }
    }

    // SYSTÈME DE COOLDOWN POUR RE-TRADING
    isTokenAlreadyProcessed(tokenAddress, currentMomentumScore = 0) {
        if (!this.tradedTokens.has(tokenAddress)) {
            return false;
        }
        
        const tradeHistory = this.tradedTokens.get(tokenAddress);
        const lastTrade = tradeHistory.lastTradeTime;
        const lastResult = tradeHistory.lastResult;
        const timeSinceLastTrade = Date.now() - lastTrade;
        
        let cooldownTime;
        if (lastResult === 'profit') {
            cooldownTime = this.retradeCooldown.afterProfit;
        } else if (lastResult === 'loss') {
            cooldownTime = this.retradeCooldown.afterLoss;
        } else {
            cooldownTime = this.retradeCooldown.normal;
        }
        
        if (timeSinceLastTrade < cooldownTime) {
            const canOverride = this.canOverrideCooldown(tradeHistory, currentMomentumScore, timeSinceLastTrade);
            
            if (canOverride) {
                console.log(`⚡ Override cooldown pour opportunité exceptionnelle`);
                return false;
            }
            
            const remainingHours = ((cooldownTime - timeSinceLastTrade) / (1000 * 60 * 60)).toFixed(1);
            console.log(`⏳ Token en cooldown (${remainingHours}h restantes)`);
            return true;
        }
        
        this.tradedTokens.delete(tokenAddress);
        return false;
    }

    canOverrideCooldown(tradeHistory, currentMomentumScore, timeSinceLastTrade) {
        if (timeSinceLastTrade < this.retradeCooldown.minCooldownOverride) return false;
        if (currentMomentumScore < this.retradeCooldown.opportunityThreshold) return false;
        if (tradeHistory.lastResult === 'loss' && timeSinceLastTrade < 24 * 60 * 60 * 1000) return false;
        return true;
    }

    markTokenAsProcessed(tokenAddress, result = 'unknown') {
        this.tradedTokens.set(tokenAddress, {
            lastTradeTime: Date.now(),
            lastResult: result,
            tradeCount: (this.tradedTokens.get(tokenAddress)?.tradeCount || 0) + 1
        });
        console.log(`📝 Token marqué: ${tokenAddress.slice(0, 8)}... (${result})`);
    }

    // SCANNER WHITELIST VIA DEXSCREENER AVEC LOGS DÉTAILLÉS
    async scanNewTokens() {
        console.log('🔍 Scan whitelist via DexScreener...');
        
        if (!this.whitelistMode.enabled || !this.whitelistMode.allowOnlyWhitelisted) {
            console.log('⚠️ Mode whitelist désactivé');
            return [];
        }
        
        try {
            const momentumTokens = [];
            const whitelistEntries = Object.entries(this.whitelistedTokens);
            
            console.log(`📊 Vérification momentum pour ${whitelistEntries.length} tokens...`);
            console.log(`🎯 Critères: 1h(≥${this.whitelistMode.minMomentum1h}%) 24h(≥${this.whitelistMode.minMomentum24h}%) vol(≥${this.whitelistMode.minVolume.toLocaleString()})`);
            console.log('─'.repeat(80));
            
            for (const [symbol, address] of whitelistEntries) {
                try {
                    console.log(`🔎 ${symbol.padEnd(8)} | Vérification...`);
                    
                    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
                    
                    if (!response.ok) {
                        console.log(`   ❌ DexScreener error ${response.status}`);
                        continue;
                    }
                    
                    const data = await response.json();
                    const pair = data.pairs?.find(p => p.chainId === 'solana');
                    
                    if (!pair) {
                        console.log(`   ❌ Pas de paire Solana trouvée`);
                        continue;
                    }
                    
                    const change1h = parseFloat(pair.priceChange?.h1 || 0);
                    const change24h = parseFloat(pair.priceChange?.h24 || 0);
                    const volume24h = parseFloat(pair.volume?.h24 || 0);
                    const liquidity = parseFloat(pair.liquidity?.usd || 0);
                    const price = parseFloat(pair.priceUsd || 0);
                    
                    // LOG DÉTAILLÉ pour chaque token
                    const change1hStr = change1h >= 0 ? `+${change1h.toFixed(1)}%` : `${change1h.toFixed(1)}%`;
                    const change24hStr = change24h >= 0 ? `+${change24h.toFixed(1)}%` : `${change24h.toFixed(1)}%`;
                    
                    console.log(`   📊 1h: ${change1hStr.padStart(8)} | 24h: ${change24hStr.padStart(8)} | Vol: ${volume24h.toLocaleString().padStart(10)} | Liq: ${liquidity.toLocaleString().padStart(10)}`);
                    
                    // Vérifier critères un par un avec détails
                    const checks = {
                        momentum1h: change1h >= this.whitelistMode.minMomentum1h,
                        momentum24h: change24h >= this.whitelistMode.minMomentum24h,
                        volume: volume24h >= this.whitelistMode.minVolume,
                        price: price > 0,
                        liquidity: liquidity > 10000 // Au moins $10k de liquidité
                    };
                    
                    const passedChecks = Object.values(checks).filter(Boolean).length;
                    const totalChecks = Object.keys(checks).length;
                    
                    console.log(`   🔍 Checks: ${passedChecks}/${totalChecks} `, Object.entries(checks).map(([key, passed]) => 
                        `${key}:${passed ? '✅' : '❌'}`
                    ).join(' '));
                    
                    // Si tous les critères sont remplis
                    if (Object.values(checks).every(Boolean)) {
                        console.log(`   🎯 ✅ ${symbol} QUALIFIÉ pour trading !`);
                        
                        const tokenData = {
                            baseToken: {
                                address: address,
                                symbol: symbol,
                                name: pair.baseToken?.name || symbol
                            },
                            priceUsd: price.toString(),
                            volume: { h24: volume24h },
                            liquidity: { usd: liquidity },
                            priceChange: { h1: change1h, h24: change24h },
                            scanReason: `🛡️ Whitelist ${symbol}`,
                            isWhitelisted: true,
                            momentumScore: (change1h * 3) + (change24h * 2),
                            dexData: pair,
                            // Infos détaillées pour debug
                            scanDetails: {
                                change1h: change1h,
                                change24h: change24h,
                                volume24h: volume24h,
                                liquidity: liquidity,
                                price: price,
                                checksResult: checks
                            }
                        };
                        
                        momentumTokens.push(tokenData);
                        
                    } else {
                        // Expliquer pourquoi le token est rejeté
                        const failedReasons = [];
                        if (!checks.momentum1h) failedReasons.push(`1h(${change1hStr}<${this.whitelistMode.minMomentum1h}%)`);
                        if (!checks.momentum24h) failedReasons.push(`24h(${change24hStr}<${this.whitelistMode.minMomentum24h}%)`);
                        if (!checks.volume) failedReasons.push(`vol(${volume24h.toLocaleString()}<${this.whitelistMode.minVolume.toLocaleString()})`);
                        if (!checks.price) failedReasons.push(`prix(${price})`);
                        if (!checks.liquidity) failedReasons.push(`liq(${liquidity.toLocaleString()}<$10k)`);
                        
                        console.log(`   ⚠️ ❌ ${symbol} REJETÉ: ${failedReasons.join(', ')}`);
                    }
                    
                } catch (tokenError) {
                    console.log(`   ❌ ${symbol}: Erreur ${tokenError.message}`);
                }
                
                // Rate limiting DexScreener
                await new Promise(resolve => setTimeout(resolve, 800)); // 800ms entre tokens
            }
            
            console.log('─'.repeat(80));
            
            // Trier par momentum 1h (le plus récent = priorité)
            const sortedTokens = momentumTokens.sort((a, b) => {
                return (b.priceChange.h1 || 0) - (a.priceChange.h1 || 0);
            });
            
            console.log(`🎯 RÉSULTAT FINAL: ${sortedTokens.length} tokens qualifiés pour trading:`);
            
            if (sortedTokens.length > 0) {
                sortedTokens.forEach((token, i) => {
                    const change1h = token.priceChange.h1;
                    const change24h = token.priceChange.h24;
                    const score = token.momentumScore;
                    const vol = token.volume.h24;
                    
                    const change1hStr = change1h >= 0 ? `+${change1h.toFixed(1)}%` : `${change1h.toFixed(1)}%`;
                    const change24hStr = change24h >= 0 ? `+${change24h.toFixed(1)}%` : `${change24h.toFixed(1)}%`;
                    
                    console.log(`   ${(i+1).toString().padStart(2)}. ${token.baseToken.symbol.padEnd(8)} | 1h: ${change1hStr.padStart(8)} | 24h: ${change24hStr.padStart(8)} | Vol: ${vol.toLocaleString().padStart(10)} | Score: ${score.toFixed(1).padStart(6)}`);
                });
            } else {
                console.log(`   📋 Aucun token ne répond aux critères actuels.`);
                console.log(`   💡 Suggestions:`);
                console.log(`      - Réduire minMomentum1h (actuellement ${this.whitelistMode.minMomentum1h}%)`);
                console.log(`      - Réduire minMomentum24h (actuellement ${this.whitelistMode.minMomentum24h}%)`);
                console.log(`      - Réduire minVolume (actuellement ${this.whitelistMode.minVolume.toLocaleString()})`);
                console.log(`      - Ajouter plus de tokens à la whitelist`);
            }
            
            console.log('═'.repeat(80));
            return sortedTokens;
            
        } catch (error) {
            console.error('❌ Erreur scan DexScreener:', error.message);
            return [];
        }
    }

    // INITIALISATION DISCORD
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

    // GESTION RPC ET RATE LIMITING
    async waitForRateLimit() {
        const now = Date.now();
        const timeSinceLastCall = now - this.lastRpcCall;
        
        if (timeSinceLastCall < this.rpcCallDelay) {
            const waitTime = this.rpcCallDelay - timeSinceLastCall;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
        this.lastRpcCall = Date.now();
    }

    async getConnection(attempt = 0) {
        if (attempt === 0) {
            return this.connection;
        } else if (attempt <= this.backupConnections.length) {
            return this.backupConnections[attempt - 1];
        } else {
            return this.connection;
        }
    }

    // VÉRIFICATION DES SOLDES AVEC CACHE
    async checkWalletBalance(tokenMint, requiredAmount, useCache = true) {
        try {
            const cacheKey = `${tokenMint}_${this.wallet.publicKey.toString()}`;
            
            if (useCache && this.balanceCache.has(cacheKey)) {
                const cached = this.balanceCache.get(cacheKey);
                if (Date.now() - cached.timestamp < this.cacheTimeout) {
                    return cached.balance >= requiredAmount;
                }
            }

            await this.waitForRateLimit();

            let balance;
            let attempts = 0;
            const maxAttempts = 3;

            while (attempts < maxAttempts) {
                try {
                    const connection = await this.getConnection(attempts);
                    
                    if (tokenMint === 'So11111111111111111111111111111111111111112') {
                        const lamports = await connection.getBalance(this.wallet.publicKey);
                        balance = lamports / 1e9;
                        const requiredSol = requiredAmount / 1e9;
                        
                        this.balanceCache.set(cacheKey, { 
                            balance: lamports, 
                            timestamp: Date.now() 
                        });
                        
                        return balance >= requiredSol + 0.01;
                    } else {
                        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
                            this.wallet.publicKey,
                            { mint: new PublicKey(tokenMint) }
                        );
                        
                        if (tokenAccounts.value.length === 0) return false;
                        
                        balance = parseFloat(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
                        
                        this.balanceCache.set(cacheKey, { 
                            balance: balance, 
                            timestamp: Date.now() 
                        });
                        
                        return balance >= requiredAmount;
                    }
                } catch (rpcError) {
                    attempts++;
                    if (rpcError.message.includes('429')) {
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

    // JUPITER API - OBTENIR QUOTE SANS VÉRIFICATION SOLDE
    async getJupiterQuote(inputMint, outputMint, amount, skipBalanceCheck = false) {
        try {
            // Vérifier solde seulement si demandé
            if (!skipBalanceCheck) {
                const hasBalance = await this.checkWalletBalance(inputMint, amount);
                if (!hasBalance) {
                    console.log(`❌ Solde insuffisant`);
                    return null;
                }
            }

            const response = await fetch(
                `https://quote-api.jup.ag/v6/quote?` +
                `inputMint=${inputMint}&` +
                `outputMint=${outputMint}&` +
                `amount=${amount}&` +
               `slippageBps=${Math.max(this.maxSlippage * 100, 1000)}&` + // Minimum 10% slippage
                `onlyDirectRoutes=false&` +
                `asLegacyTransaction=false`,
                {
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            if (response.ok) {
                const quote = await response.json();
                
                if (quote.error) {
                    console.log(`❌ Jupiter error: ${quote.error}`);
                    return null;
                }
                
                if (quote.outAmount && parseFloat(quote.outAmount) > 0) {
                    return quote;
                }
            } else if (response.status === 429) {
                console.log(`⚠️ Rate limit Jupiter - attendre...`);
                await new Promise(resolve => setTimeout(resolve, 5000));
                return null;
            }
            
            return null;
            
        } catch (error) {
            console.log(`❌ Erreur Jupiter quote: ${error.message}`);
            return null;
        }
    }

    // JUPITER API - EXÉCUTER SWAP
    async executeSwap(quote) {
        try {
            const hasBalance = await this.checkWalletBalance(quote.inputMint, parseFloat(quote.inAmount));
            if (!hasBalance) {
                console.log(`❌ Solde insuffisant au moment du swap`);
                return null;
            }

            const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    quoteResponse: quote,
                    userPublicKey: this.wallet.publicKey.toString(),
                    wrapAndUnwrapSol: true,
                    dynamicComputeUnitLimit: true,
                    prioritizationFeeLamports: 'auto'
                })
            });
            
            if (!swapResponse.ok) {
                throw new Error(`Swap API error: ${swapResponse.status}`);
            }
            
            const { swapTransaction } = await swapResponse.json();
            if (!swapTransaction) {
                throw new Error('Pas de transaction reçue');
            }
            
            const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
            const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
            transaction.sign([this.wallet]);
            
            let txid = null;
            let attempts = 0;
            const maxAttempts = 3;
            
            while (attempts < maxAttempts && !txid) {
                try {
                    attempts++;
                    txid = await this.connection.sendTransaction(transaction, {
                        preflightCommitment: 'confirmed',
                        maxRetries: 0,
                        skipPreflight: false
                    });
                    
                    if (txid) break;
                } catch (sendError) {
                    if (sendError.message.includes('simulation failed') || 
                        sendError.message.includes('insufficient funds')) {
                        throw sendError;
                    }
                    
                    if (attempts < maxAttempts) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                }
            }
            
            if (!txid) {
                throw new Error(`Impossible d'envoyer après ${maxAttempts} tentatives`);
            }
            
            const confirmed = await this.confirmTransactionPolling(txid);
            
            if (confirmed) {
                console.log(`✅ Transaction confirmée: ${txid}`);
                return txid;
            } else {
                console.log(`⚠️ Timeout confirmation: ${txid}`);
                return txid;
            }
            
        } catch (error) {
            console.error(`❌ Erreur swap: ${error.message}`);
            return null;
        }
    }

    // CONFIRMATION TRANSACTION PAR POLLING
    async confirmTransactionPolling(txid, maxRetries = 30) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                await this.waitForRateLimit();
                
                const status = await this.connection.getSignatureStatus(txid);
                
                if (status?.value?.confirmationStatus === 'confirmed' || 
                    status?.value?.confirmationStatus === 'finalized') {
                    return true;
                }
                
                if (status?.value?.err) {
                    console.log(`❌ Transaction échouée: ${JSON.stringify(status.value.err)}`);
                    return false;
                }
                
                await new Promise(resolve => setTimeout(resolve, 2000));
                
            } catch (error) {
                if (i === maxRetries - 1) return false;
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        return false;
    }

    // TEST DE VENDABILITÉ AVEC DEBUG POUR HNT
    async testTokenSellability(tokenAddress) {
        try {
            console.log(`🧪 Test vendabilité ${tokenAddress.slice(0,8)}...`);
            
            // Vérifier d'abord l'adresse sur Solana Explorer
            // Vérifier d'abord l'adresse sur Solana Explorer
            // Vérifier l'adresse Solana (43 ou 44 caractères possibles)
            if (!tokenAddress || tokenAddress.length < 43 || tokenAddress.length > 44) {
                console.log(`   🔍 Adresse complète: ${tokenAddress}`);
                console.log(`   📏 Longueur: ${tokenAddress ? tokenAddress.length : 'undefined'}`);
                return { canSell: false, reason: `Adresse invalide (longueur: ${tokenAddress ? tokenAddress.length : 'undefined'})` };
            }
            
            const solMint = 'So11111111111111111111111111111111111111112';
            const testAmount = 1000000; // 1M de tokens de test
            
            console.log(`   🔍 Test route Jupiter: ${tokenAddress} → SOL`);
            
            const response = await fetch(
                `https://quote-api.jup.ag/v6/quote?` +
                `inputMint=${tokenAddress}&` +
                `outputMint=${solMint}&` +
                `amount=${testAmount}&` +
                `slippageBps=1000&` +
                `onlyDirectRoutes=false`, // Autoriser routes indirectes
                {
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            console.log(`   📡 Jupiter response status: ${response.status}`);
            
            if (response.ok) {
                const quote = await response.json();
                
                if (quote.error) {
                    console.log(`   ❌ Jupiter error détaillée: ${quote.error}`);
                    
                    if (quote.error.includes('No routes found')) {
                        return { canSell: false, reason: 'Aucune route Jupiter trouvée' };
                    } else if (quote.error.includes('Token not found')) {
                        return { canSell: false, reason: 'Token non reconnu par Jupiter' };
                    } else {
                        return { canSell: false, reason: `Jupiter: ${quote.error}` };
                    }
                }
                
                if (quote.outAmount && parseFloat(quote.outAmount) > 0) {
                    const outSol = parseFloat(quote.outAmount) / 1e9;
                    console.log(`   ✅ Route trouvée: ${testAmount.toLocaleString()} tokens → ${outSol.toFixed(8)} SOL`);
                    console.log(`   🛣️ Route: ${quote.routePlan?.length || 'N/A'} étapes`);
                    return { canSell: true, reason: 'Route Jupiter confirmée' };
                } else {
                    console.log(`   ❌ Quote invalide - outAmount: ${quote.outAmount}`);
                    return { canSell: false, reason: 'Quote Jupiter invalide' };
                }
                
            } else if (response.status === 429) {
                console.log(`   ⚠️ Rate limit Jupiter - on continue...`);
                return { canSell: true, reason: 'Rate limit - route probablement OK' };
            } else {
                const errorText = await response.text().catch(() => 'Unknown error');
                console.log(`   ❌ Jupiter API ${response.status}: ${errorText}`);
                return { canSell: false, reason: `API Error ${response.status}` };
            }
            
        } catch (error) {
            console.log(`   ❌ Erreur réseau: ${error.message}`);
            return { canSell: false, reason: `Erreur: ${error.message}` };
        }
    }

    // ACHAT DE TOKEN AVEC POSITION SIZING VARIABLE
    async buyToken(tokenAddress, tokenData) {
        try {
            const symbol = tokenData.baseToken.symbol;
            
            // Vérification whitelist absolue
            if (this.whitelistMode.enabled && this.whitelistMode.allowOnlyWhitelisted) {
                if (!this.whitelistedTokens[symbol]) {
                    console.log(`🚨 SKIP ${symbol}: Non whitelisté`);
                    this.banAddress(tokenAddress, 'Not in whitelist');
                    return false;
                }
                
                const expectedAddress = this.whitelistedTokens[symbol];
                if (expectedAddress !== tokenAddress) {
                    console.log(`🚨 SKIP ${symbol}: SCAM détecté !`);
                    this.banAddress(tokenAddress, `SCAM: Fake ${symbol}`);
                    return false;
                }
            }
            
            // Test de vendabilité SIMPLE
            const sellTest = await this.testTokenSellability(tokenAddress);
            if (!sellTest.canSell) {
                console.log(`🚨 SKIP ${symbol}: ${sellTest.reason}`);
                this.banAddress(tokenAddress, sellTest.reason);
                return false;
            }
            console.log(`✅ ${symbol}: ${sellTest.reason}`);
            
            // POSITION SIZING VARIABLE (nouveau)
            let dynamicBuyAmount = this.buyAmount;
            
            // Size plus petit pour memecoins
            if (['BONK', 'WIF', 'POPCAT', 'PENGU', 'FARTCOIN', 'AGI', 'ZBCN'].includes(symbol)) {
                dynamicBuyAmount = this.buyAmount ; // 30% moins pour memes
                console.log(`🎭 Memecoin détecté: Taille réduite à ${dynamicBuyAmount.toFixed(3)} SOL`);
            }
            
            // Size plus gros pour DeFi établi  
            if (['JUP', 'RAY', 'ORCA', 'PYTH', 'JTO', 'DRIFT'].includes(symbol)) {
                dynamicBuyAmount = this.buyAmount ; // 30% plus pour DeFi sûr
                console.log(`🏦 DeFi établi détecté: Taille augmentée à ${dynamicBuyAmount.toFixed(3)} SOL`);
            }
            
            // Exécution de l'achat
            const solAmount = dynamicBuyAmount * 1e9;
            const solMint = 'So11111111111111111111111111111111111111112';
            
            const buyQuote = await this.getJupiterQuote(solMint, tokenAddress, solAmount, false); // Avec vérification solde
            if (!buyQuote) {
                console.log(`❌ Quote impossible pour ${symbol}`);
                return false;
            }
            
            const txid = await this.executeSwap(buyQuote);
            
            if (txid) {
                const tokenAmount = parseFloat(buyQuote.outAmount);
                const price = parseFloat(tokenData.priceUsd || 0);
                
                const position = {
                    tokenAddress,
                    symbol: symbol,
                    buyPrice: price,
                    buyAmount: tokenAmount,
                    currentAmount: tokenAmount,
                    buyTxid: txid,
                    buyTime: Date.now(),
                    solSpent: dynamicBuyAmount, // Utiliser le montant dynamique
                    sellsExecuted: [],
                    totalSolReceived: 0,
                    partialSells: 0,
                    highestPrice: price,
                    highestPercent: 0,
                    isWhitelisted: true,
                    confidenceLevel: 'HIGH',
                    category: this.getCategoryFromSymbol(symbol) // Pour les stats
                };
                
                this.positions.set(tokenAddress, position);
                
                // METTRE À JOUR LES STATISTIQUES
                this.updateStatsOnBuy(dynamicBuyAmount, symbol);
                
                console.log(`✅ ACHAT RÉUSSI: ${symbol}`);
                console.log(`   💰 Prix: ${price.toFixed(6)}`);
                console.log(`   🪙 Quantité: ${tokenAmount.toLocaleString()}`);
                console.log(`   💎 Investissement: ${dynamicBuyAmount.toFixed(3)} SOL`);
                console.log(`   🔗 TX: ${txid}`);
                
                await this.notifyBuy(position, tokenData);
                return true;
            }
            
            return false;
            
        } catch (error) {
            console.error(`❌ Erreur achat ${tokenData.baseToken?.symbol}: ${error.message}`);
            return false;
        }
    }

    // HELPER: Déterminer catégorie du token
    getCategoryFromSymbol(symbol) {
        const memecoins = ['BONK', 'WIF', 'POPCAT', 'PENGU', 'FARTCOIN', 'AGI', 'ZBCN'];
        const defi = ['JUP', 'RAY', 'ORCA', 'PYTH', 'JTO', 'DRIFT'];
        const infrastructure = ['SOL', 'RENDER', 'HNT'];
        const ai = ['GRASS', 'AI16Z'];
        
        if (memecoins.includes(symbol)) return 'meme';
        if (defi.includes(symbol)) return 'defi';
        if (infrastructure.includes(symbol)) return 'infrastructure';
        if (ai.includes(symbol)) return 'ai';
        return 'other';
    }   
    // GESTION DES STATISTIQUES
updateStatsOnBuy(solSpent, symbol) {
    // Session
    this.stats.session.trades++;
    this.stats.session.investedSOL += solSpent;
    
    // Daily - reset si nouveau jour
    const currentDate = new Date().toDateString();
    if (this.stats.daily.date !== currentDate) {
        this.stats.daily = {
            date: currentDate,
            trades: 0,
            wins: 0,
            losses: 0,
            profitSOL: 0,
            investedSOL: 0
        };
    }
    this.stats.daily.trades++;
    this.stats.daily.investedSOL += solSpent;
    
    // Hourly - reset si nouvelle heure
    const currentHour = new Date().getHours();
    if (this.stats.hourly.hour !== currentHour) {
        this.stats.hourly = {
            hour: currentHour,
            trades: 0,
            wins: 0,
            losses: 0,
            profitSOL: 0
        };
    }
    this.stats.hourly.trades++;
    
    // All time
    this.stats.allTime.totalTrades++;
    this.stats.allTime.totalInvestedSOL += solSpent;
    
    console.log(`📊 Stats mise à jour: ${this.stats.session.trades} trades session`);
}

updateStatsOnSell(solReceived, solSpent, profitPercent, buyTime, symbol, result) {
    const profit = solReceived - solSpent;
    const holdTime = Date.now() - buyTime;
    
    // Mettre à jour toutes les périodes
    [this.stats.session, this.stats.daily, this.stats.hourly, this.stats.allTime].forEach(period => {
        if (result === 'profit') {
            period.wins++;
        } else if (result === 'loss') {
            period.losses++;
        }
        
        if (period.profitSOL !== undefined) {
            period.profitSOL += profit;
        }
    });
    
    // All time spécifique
    this.stats.allTime.totalProfitSOL += profit;
    this.stats.allTime.totalHoldTime += holdTime;
    this.stats.allTime.avgHoldTime = this.stats.allTime.totalHoldTime / this.stats.allTime.totalTrades;
    
    // Best/Worst trades
    if (profitPercent > this.stats.allTime.bestTrade.profit) {
        this.stats.allTime.bestTrade = { symbol, profit: profitPercent };
    }
    if (profitPercent < this.stats.allTime.worstTrade.profit) {
        this.stats.allTime.worstTrade = { symbol, profit: profitPercent };
    }
    
    console.log(`📈 Trade fermé: ${symbol} ${profit > 0 ? '+' : ''}${profit.toFixed(4)} SOL`);
}

// AFFICHAGE RÉCAP COMPLET


    // SURVEILLANCE ET GESTION DES POSITIONS
    async checkPositions() {
        if (this.positions.size === 0) return;
        
        console.log(`📊 Check de ${this.positions.size} positions...`);
        
        for (const [tokenAddress, position] of this.positions.entries()) {
            try {
                await this.checkSinglePosition(tokenAddress, position);
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                console.error(`❌ Erreur check position ${position.symbol}: ${error.message}`);
            }
        }
    }
        // RÉCAP PERFORMANCE DISCORD
async sendPerformanceRecapToDiscord() {
    try {
        const channel = await this.client.channels.fetch(this.channelId);
        if (!channel) return;

        const now = new Date();
        const sessionHours = ((Date.now() - this.stats.session.startTime) / (1000 * 60 * 60)).toFixed(1);
        
        // Calculer les pourcentages
        const sessionWinRate = this.stats.session.trades > 0 ? 
            ((this.stats.session.wins / this.stats.session.trades) * 100).toFixed(1) : '0';
        const sessionROI = this.stats.session.investedSOL > 0 ? 
            ((this.stats.session.profitSOL / this.stats.session.investedSOL) * 100).toFixed(1) : '0';
            
        const dailyWinRate = this.stats.daily.trades > 0 ? 
            ((this.stats.daily.wins / this.stats.daily.trades) * 100).toFixed(1) : '0';
        const dailyROI = this.stats.daily.investedSOL > 0 ? 
            ((this.stats.daily.profitSOL / this.stats.daily.investedSOL) * 100).toFixed(1) : '0';
            
        const allTimeWinRate = this.stats.allTime.totalTrades > 0 ? 
            ((this.stats.allTime.wins / this.stats.allTime.totalTrades) * 100).toFixed(1) : '0';
        const allTimeROI = this.stats.allTime.totalInvestedSOL > 0 ? 
            ((this.stats.allTime.totalProfitSOL / this.stats.allTime.totalInvestedSOL) * 100).toFixed(1) : '0';

        // Embed principal
        const embed = new EmbedBuilder()
            .setColor(this.stats.session.profitSOL >= 0 ? 0x00ff00 : 0xff9900)
            .setTitle('📊 RÉCAP PERFORMANCE AUTO-TRADER')
            .setDescription(`**Rapport automatique toutes les 10 minutes**`)
            .addFields(
                {
                    name: `🕐 SESSION (${sessionHours}h)`,
                    value: `Trades: ${this.stats.session.trades} | Wins: ${this.stats.session.wins} | Losses: ${this.stats.session.losses}\n` +
                           `Win Rate: ${sessionWinRate}% | ROI: ${sessionROI}%\n` +
                           `Investi: ${this.stats.session.investedSOL.toFixed(3)} SOL\n` +
                           `Profit: ${this.stats.session.profitSOL > 0 ? '+' : ''}${this.stats.session.profitSOL.toFixed(4)} SOL`,
                    inline: false
                },
                {
                    name: `📅 AUJOURD'HUI`,
                    value: `Trades: ${this.stats.daily.trades} | Wins: ${this.stats.daily.wins} | Losses: ${this.stats.daily.losses}\n` +
                           `Win Rate: ${dailyWinRate}% | ROI: ${dailyROI}%\n` +
                           `Investi: ${this.stats.daily.investedSOL.toFixed(3)} SOL\n` +
                           `Profit: ${this.stats.daily.profitSOL > 0 ? '+' : ''}${this.stats.daily.profitSOL.toFixed(4)} SOL`,
                    inline: false
                },
                {
                    name: `🏆 ALL TIME`,
                    value: `Trades: ${this.stats.allTime.totalTrades} | Wins: ${this.stats.allTime.wins} | Losses: ${this.stats.allTime.losses}\n` +
                           `Win Rate: ${allTimeWinRate}% | ROI: ${allTimeROI}%\n` +
                           `Investi: ${this.stats.allTime.totalInvestedSOL.toFixed(3)} SOL\n` +
                           `Profit Total: ${this.stats.allTime.totalProfitSOL > 0 ? '+' : ''}${this.stats.allTime.totalProfitSOL.toFixed(4)} SOL`,
                    inline: false
                }
            )
            .setTimestamp();

        // Ajouter positions actuelles si il y en a
        if (this.positions.size > 0) {
            let positionsText = '';
            for (const [, position] of this.positions.entries()) {
                const currentPrice = position.lastKnownPrice || position.buyPrice;
                const changePercent = ((currentPrice / position.buyPrice) - 1) * 100;
                const holdTimeMin = ((Date.now() - position.buyTime) / (1000 * 60)).toFixed(0);
                
                const emoji = changePercent > 10 ? '🚀' : changePercent > 0 ? '📈' : changePercent > -10 ? '⚠️' : '🔴';
                positionsText += `${emoji} ${position.symbol}: ${changePercent > 0 ? '+' : ''}${changePercent.toFixed(1)}% (${holdTimeMin}min)\n`;
            }
            
            embed.addFields({
                name: `💼 POSITIONS ACTUELLES (${this.positions.size})`,
                value: positionsText || 'Aucune position ouverte',
                inline: false
            });
        }

        await channel.send({
            embeds: [embed]
        });
        
        console.log('📊 Récap performance envoyé sur Discord');
        
    } catch (error) {
        console.error('❌ Erreur envoi récap Discord:', error.message);
        // Fallback console si Discord fail
        console.log('📊 Fallback: Récap en console');
        this.showPerformanceRecapConsole();
    }
}

// Version console en backup
showPerformanceRecapConsole() {
    const now = new Date();
    const sessionHours = ((Date.now() - this.stats.session.startTime) / (1000 * 60 * 60)).toFixed(1);
    
    console.log('\n' + '═'.repeat(80));
    console.log(`📊 RÉCAP PERFORMANCE - ${now.toLocaleString()}`);
    console.log('═'.repeat(80));
    
    const sessionWinRate = this.stats.session.trades > 0 ? 
        ((this.stats.session.wins / this.stats.session.trades) * 100).toFixed(1) : '0';
    const sessionROI = this.stats.session.investedSOL > 0 ? 
        ((this.stats.session.profitSOL / this.stats.session.investedSOL) * 100).toFixed(1) : '0';
        
    console.log(`🕐 SESSION (${sessionHours}h):`);
    console.log(`   Trades: ${this.stats.session.trades} | Wins: ${this.stats.session.wins} | Losses: ${this.stats.session.losses} | WR: ${sessionWinRate}%`);
    console.log(`   Investi: ${this.stats.session.investedSOL.toFixed(3)} SOL | Profit: ${this.stats.session.profitSOL > 0 ? '+' : ''}${this.stats.session.profitSOL.toFixed(4)} SOL | ROI: ${sessionROI}%`);
    console.log('═'.repeat(80));
}
    async checkSinglePosition(tokenAddress, position) {
        try {
            // Obtenir le prix actuel via DexScreener
            const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
            if (!response.ok) return;
            
            const data = await response.json();
            const pair = data.pairs?.find(p => p.chainId === 'solana');
            if (!pair) return;
            
            const currentPrice = parseFloat(pair.priceUsd || 0);
            if (currentPrice <= 0) return;
            
            const changePercent = ((currentPrice / position.buyPrice) - 1) * 100;
            const holdTime = Date.now() - position.buyTime;
            
            // Mettre à jour le plus haut prix atteint
            if (currentPrice > position.highestPrice) {
                position.highestPrice = currentPrice;
                position.highestPercent = changePercent;
            }
            
            position.lastKnownPrice = currentPrice;
            
            console.log(`   💎 ${position.symbol}: ${changePercent > 0 ? '+' : ''}${changePercent.toFixed(1)}% (${((holdTime) / (1000 * 60)).toFixed(0)}min)`);
            
            // 1. VÉRIFIER STOP-LOSS
            if (changePercent <= -this.stopLossPercent) {
                console.log(`🛑 Stop-Loss déclenché: ${position.symbol} (${changePercent.toFixed(1)}%)`);
                await this.sellEntirePosition(position, currentPrice, `Stop-Loss -${this.stopLossPercent}%`);
                return;
            }
            
            // 2. VÉRIFIER TRAILING STOP
            if (this.useTrailingStop && position.highestPercent > 0) {
                const trailingStopPrice = position.highestPrice * (1 - this.trailingStopPercent / 100);
                if (currentPrice <= trailingStopPrice) {
                    const trailingLoss = ((currentPrice / position.highestPrice) - 1) * 100;
                    console.log(`📉 Trailing Stop déclenché: ${position.symbol} (${trailingLoss.toFixed(1)}% depuis le max)`);
                    await this.sellEntirePosition(position, currentPrice, `Trailing Stop depuis +${position.highestPercent.toFixed(1)}%`);
                    return;
                }
            }
            
            // 3. VÉRIFIER SORTIE PAR STAGNATION
            if (this.stagnationExit.enabled) {
                if (holdTime > this.stagnationExit.maxHoldTime) {
                    console.log(`⏰ Sortie par temps maximum: ${position.symbol} (4h atteintes)`);
                    await this.sellEntirePosition(position, currentPrice, "Temps maximum atteint (4h)");
                    return;
                }
                
                if (holdTime > this.stagnationExit.stagnantTime && 
                    Math.abs(changePercent) < this.stagnationExit.stagnantThreshold) {
                    console.log(`😴 Sortie par stagnation: ${position.symbol} (±${this.stagnationExit.stagnantThreshold}% depuis 2h)`);
                    await this.sellEntirePosition(position, currentPrice, "Position stagnante");
                    return;
                }
                
                if (holdTime > this.stagnationExit.lossExitTime && 
                    changePercent < this.stagnationExit.lossThreshold) {
                    console.log(`🔴 Sortie par perte prolongée: ${position.symbol} (${changePercent.toFixed(1)}% depuis 1h30)`);
                    await this.sellEntirePosition(position, currentPrice, "Perte prolongée");
                    return;
                }
            }
            
            // 4. VÉRIFIER VENTES ÉCHELONNÉES
            await this.checkStagedSells(position, changePercent, currentPrice);
            
        } catch (error) {
            console.error(`❌ Erreur check position ${position.symbol}: ${error.message}`);
        }
    }

    // VENTES ÉCHELONNÉES
    async checkStagedSells(position, changePercent, currentPrice) {
        // Détecter si c'est un moonshot (>1000%)
        const isMoonshot = changePercent > 1000;
        
        if (isMoonshot) {
            console.log(`🌙 MOONSHOT DÉTECTÉ: ${position.symbol} +${changePercent.toFixed(0)}%`);
            
            if (!position.moonshotSellAttempted) {
                position.moonshotSellAttempted = true;
                const success = await this.handleMoonshotSell(position, currentPrice, `+${changePercent.toFixed(0)}%`);
                if (success) return;
            }
        }
        
        // Vérifier chaque niveau de vente
        for (const level of this.sellLevels) {
            if (changePercent >= level.profit && !position.sellsExecuted.includes(level.profit)) {
                
                const remainingAmount = position.currentAmount;
                let amountToSell = remainingAmount * (level.percentage / 100);
                
                // Pour moonshots, réduire les montants
                if (isMoonshot) {
                    amountToSell = Math.min(amountToSell, remainingAmount * 0.1);
                }
                
                if (amountToSell > 0) {
                    console.log(`🎯 Vente échelonnée: ${position.symbol} +${changePercent.toFixed(1)}%`);
                    console.log(`   💰 Vendre ${level.percentage}% (${amountToSell.toLocaleString()} tokens)`);
                    
                    const success = await this.sellPartialPosition(position, amountToSell, level, currentPrice);
                    
                    if (success) {
                        position.sellsExecuted.push(level.profit);
                        position.currentAmount = remainingAmount - amountToSell;
                        
                        if (position.currentAmount <= position.buyAmount * 0.01) {
                            console.log(`✅ Position ${position.symbol} entièrement vendue`);
                            this.positions.delete(position.tokenAddress);
                            break;
                        }
                    } else if (isMoonshot) {
                        position.sellsExecuted.push(level.profit);
                    }
                }
            }
        }
    }

    // GESTION VENTE MOONSHOT
    async handleMoonshotSell(position, currentPrice, reason) {
        console.log(`🌙 Gestion vente moonshot: ${position.symbol}`);
        
        const totalSellSuccess = await this.sellEntirePosition(position, currentPrice, `Moonshot ${reason}`);
        
        if (totalSellSuccess) {
            console.log(`✅ Vente totale moonshot réussie !`);
            return true;
        }
        
        const chunkSuccess = await this.sellMoonshotInChunks(position, currentPrice);
        if (chunkSuccess) return true;
        
        console.log(`⚠️ Vente moonshot impossible - surveillance continue`);
        position.moonshotSellFailed = true;
        position.lastFailedSellTime = Date.now();
        
        return false;
    }

    // VENTE PAR CHUNKS POUR MOONSHOTS
    async sellMoonshotInChunks(position, currentPrice) {
        try {
            const tokenMint = position.tokenAddress;
            
            await this.waitForRateLimit();
            const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                this.wallet.publicKey,
                { mint: new PublicKey(tokenMint) }
            );
            
            if (tokenAccounts.value.length === 0) return false;
            
            const totalBalance = parseFloat(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
            const chunkSize = Math.floor(totalBalance * 0.1);
            const maxChunks = 5;
            let soldChunks = 0;
            let totalSolReceived = 0;
            
            for (let i = 0; i < maxChunks; i++) {
                const quote = await this.getJupiterQuote(tokenMint, 'So11111111111111111111111111111111111111112', chunkSize);
                
                if (quote) {
                    const txid = await this.executeSwap(quote);
                    
                    if (txid) {
                        const solReceived = parseFloat(quote.outAmount) / 1e9;
                        totalSolReceived += solReceived;
                        soldChunks++;
                        
                        position.totalSolReceived = (position.totalSolReceived || 0) + solReceived;
                        position.partialSells++;
                        
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            }
            
            if (soldChunks > 0) {
                await this.notifyMoonshotChunkSell(position, soldChunks, totalSolReceived, currentPrice);
                return true;
            }
            
            return false;
            
        } catch (error) {
            console.error(`❌ Erreur vente chunks: ${error.message}`);
            return false;
        }
    }

    // VENTE PARTIELLE
    async sellPartialPosition(position, amountToSell, level, currentPrice) {
        try {
            const tokenMint = position.tokenAddress;
            const solMint = 'So11111111111111111111111111111111111111112';
            const roundedAmount = Math.floor(amountToSell);
            
            if (roundedAmount <= 0) return false;
            
            const hasTokens = await this.checkWalletBalance(tokenMint, roundedAmount);
            if (!hasTokens) return false;
            
            const sellQuote = await this.getJupiterQuote(tokenMint, solMint, roundedAmount);
            if (!sellQuote) return false;
            
            const txid = await this.executeSwap(sellQuote);
            
            if (txid) {
                const solReceived = parseFloat(sellQuote.outAmount) / 1e9;
                const partialProfit = solReceived - (position.solSpent * (level.percentage / 100));
                const partialProfitPercent = ((currentPrice / position.buyPrice) - 1) * 100;
                
                await this.notifyPartialSell(position, solReceived, partialProfit, partialProfitPercent, level, txid);
                
                position.totalSolReceived += solReceived;
                position.partialSells += 1;
                
                return true;
            }
            
            return false;
        } catch (error) {
            console.error(`❌ Erreur vente partielle: ${error.message}`);
            return false;
        }
    }

    // VENTE TOTALE
    async sellEntirePosition(position, currentPrice, reason) {
        try {
            const tokenMint = position.tokenAddress;
            const solMint = 'So11111111111111111111111111111111111111112';
            
            await this.waitForRateLimit();
            const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                this.wallet.publicKey,
                { mint: new PublicKey(tokenMint) }
            );
            
            if (tokenAccounts.value.length === 0) {
                this.markTokenAsProcessed(position.tokenAddress, 'loss');
                this.positions.delete(position.tokenAddress);
                return false;
            }
            
            const realBalance = parseFloat(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
            const amountToSell = Math.floor(realBalance * 0.99);
            
            if (amountToSell <= 0) {
                const tradeResult = position.totalSolReceived > 0 ? 'profit' : 'breakeven';
                this.markTokenAsProcessed(position.tokenAddress, tradeResult);
                this.positions.delete(position.tokenAddress);
                return false;
            }
            
            const sellQuote = await this.getJupiterQuote(tokenMint, solMint, amountToSell);
            if (!sellQuote) return false;
            
            const txid = await this.executeSwap(sellQuote);
            
            if (txid) {
                const solReceived = parseFloat(sellQuote.outAmount) / 1e9;
                const totalSolReceived = position.totalSolReceived + solReceived;
                const totalProfit = totalSolReceived - position.solSpent;
                const totalProfitPercent = ((totalSolReceived / position.solSpent) - 1) * 100;
                
                // Déterminer le résultat pour le système de cooldown
                let tradeResult;
                if (totalProfitPercent > 10) {
                    tradeResult = 'profit';
                } else if (totalProfitPercent < -5) {
                    tradeResult = 'loss';
                } else {
                    tradeResult = 'breakeven';
                }
                
                // METTRE À JOUR LES STATISTIQUES
                this.updateStatsOnSell(totalSolReceived, position.solSpent, totalProfitPercent, position.buyTime, position.symbol, tradeResult);
                
                this.markTokenAsProcessed(position.tokenAddress, tradeResult);
                
                // Stocker infos pour l'historique
                if (this.tradedTokens.has(position.tokenAddress)) {
                    const history = this.tradedTokens.get(position.tokenAddress);
                    history.finalProfit = totalProfitPercent;
                    history.holdTimeMinutes = parseInt(((Date.now() - position.buyTime) / (1000 * 60)));
                    history.partialSells = position.partialSells;
                    history.exitReason = reason;
                    history.totalSolReceived = totalSolReceived;
                }
                
                await this.notifyFinalSell(position, totalSolReceived, totalProfit, totalProfitPercent, reason, txid);
                
                this.positions.delete(position.tokenAddress);
                
                // Invalider le cache SOL
                const cacheKey = `${solMint}_${this.wallet.publicKey.toString()}`;
                this.balanceCache.delete(cacheKey);
                
                return true;
            }
            
            return false;
            
        } catch (error) {
            console.error(`❌ Erreur vente totale: ${error.message}`);
            this.markTokenAsProcessed(position.tokenAddress, 'loss');
            return false;
        }
    }

    // TRAITEMENT DES NOUVEAUX TOKENS
    async processNewTokens(tokens) {
        if (this.positions.size >= this.maxConcurrentPositions) {
            console.log(`⏸️ Maximum de positions atteint (${this.maxConcurrentPositions})`);
            return 0;
        }
        
        let boughtCount = 0;
        const maxToBuy = this.maxConcurrentPositions - this.positions.size;
        
        for (const tokenData of tokens.slice(0, maxToBuy * 2)) {
            try {
                const tokenAddress = tokenData.baseToken?.address;
                if (!tokenAddress) continue;
                
                if (this.isAddressBanned(tokenAddress)) continue;
                if (this.isTokenAlreadyProcessed(tokenAddress, tokenData.momentumScore || 0)) continue;
                if (this.positions.has(tokenAddress)) continue;
                
                const bought = await this.buyToken(tokenAddress, tokenData);
                
                if (bought) {
                    this.markTokenAsProcessed(tokenAddress);
                    boughtCount++;
                    
                    if (boughtCount >= maxToBuy) break;
                }
                
                await new Promise(resolve => setTimeout(resolve, 3000));
                
            } catch (error) {
                console.error(`❌ Erreur traitement token: ${error.message}`);
            }
        }
        
        return boughtCount;
    }

    // NOTIFICATIONS DISCORD
    async notifyBuy(position, tokenData) {
        try {
            const channel = await this.client.channels.fetch(this.channelId);
            if (!channel) return;
            
            const embed = new EmbedBuilder()
                .setColor(0x00ff00)
                .setTitle(`🛡️ ACHAT SÉCURISÉ - ${position.symbol}`)
                .setDescription(`**Token whitelist vérifié acheté**`)
                .addFields(
                    {
                        name: '💰 Détails achat',
                        value: `Prix: ${position.buyPrice.toFixed(6)}\nQuantité: ${position.buyAmount.toLocaleString()}\nInvesti: ${position.solSpent} SOL`,
                        inline: true
                    },
                    {
                        name: '📊 Performance',
                        value: `1h: +${tokenData.priceChange?.h1?.toFixed(1) || 'N/A'}%\n24h: +${tokenData.priceChange?.h24?.toFixed(1) || 'N/A'}%`,
                        inline: true
                    },
                    {
                        name: '🎯 Stratégie',
                        value: `Ventes: +20% (50%), +75% (60%), +200% (75%), +500% (90%)\nStop-Loss: -${this.stopLossPercent}%`,
                        inline: false
                    },
                        {
                            name: '🔗 Liens',
                            value: `[📊 DexScreener](https://dexscreener.com/solana/${position.tokenAddress}) | [🔍 TX Achat](https://solscan.io/tx/${position.buyTxid})`,
                            inline: false
                        }
                )
                .setTimestamp();
            
            await channel.send({
                content: `🛡️ **ACHAT SÉCURISÉ** 🛡️\n${position.symbol} - Token whitelist vérifié !`,
                embeds: [embed]
            });
            
        } catch (error) {
            console.error('❌ Erreur notification achat:', error.message);
        }
    }

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
                        name: '💰 SOL reçu',
                        value: `${solReceived.toFixed(4)} SOL`,
                        inline: true
                    },
                    {
                        name: '📈 Performance',
                        value: `+${profitPercent.toFixed(1)}%`,
                        inline: true
                    },
                    {
                        name: '⏱️ Durée',
                        value: `${((Date.now() - position.buyTime) / (1000 * 60)).toFixed(0)} min`,
                        inline: true
                    }
                )
                .setTimestamp();
            
            await channel.send({
                content: `💰 **VENTE PARTIELLE** 💰\n${position.symbol}: ${level.percentage}% vendu à +${profitPercent.toFixed(1)}%`,
                embeds: [embed]
            });
            
        } catch (error) {
            console.error('❌ Erreur notification vente partielle:', error.message);
        }
    }

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
                        name: `${emoji} Profit/Perte`,
                        value: `${totalProfit > 0 ? '+' : ''}${totalProfit.toFixed(4)} SOL`,
                        inline: true
                    },
                    {
                        name: '📊 Performance',
                        value: `${totalProfitPercent > 0 ? '+' : ''}${totalProfitPercent.toFixed(1)}%`,
                        inline: true
                    },
                    {
                        name: '⏱️ Durée totale',
                        value: `${((Date.now() - position.buyTime) / (1000 * 60)).toFixed(0)} minutes`,
                        inline: true
                    }
                )
                .setTimestamp();
            
            await channel.send({
                content: `${isProfit ? '🎉' : '😢'} **POSITION FERMÉE** ${isProfit ? '🎉' : '😢'}\n${position.symbol}: ${totalProfitPercent > 0 ? '+' : ''}${totalProfitPercent.toFixed(1)}% total`,
                embeds: [embed]
            });
            
        } catch (error) {
            console.error('❌ Erreur notification vente finale:', error.message);
        }
    }

    async notifyMoonshotChunkSell(position, soldChunks, totalSolReceived, currentPrice) {
        try {
            const channel = await this.client.channels.fetch(this.channelId);
            if (!channel) return;
            
            const changePercent = ((currentPrice / position.buyPrice) - 1) * 100;
            
            const embed = new EmbedBuilder()
                .setColor(0xffd700)
                .setTitle(`🌙 MOONSHOT PARTIEL - ${position.symbol}`)
                .setDescription(`**Vente par chunks réussie !**`)
                .addFields(
                    {
                        name: '🚀 Performance',
                        value: `+${changePercent.toFixed(0)}%`,
                        inline: true
                    },
                    {
                        name: '🧩 Chunks vendus',
                        value: `${soldChunks}/5 chunks`,
                        inline: true
                    },
                    {
                        name: '💰 SOL reçu',
                        value: `${totalSolReceived.toFixed(4)} SOL`,
                        inline: true
                    }
                )
                .setTimestamp();
            
            await channel.send({
                content: `🌙 **MOONSHOT ALERT** 🌙\n${position.symbol}: +${changePercent.toFixed(0)}% - Vente partielle réussie !`,
                embeds: [embed]
            });
            
        } catch (error) {
            console.error('❌ Erreur notification moonshot:', error.message);
        }
    }

    // AFFICHAGE DES COOLDOWNS ACTIFS
    showActiveCooldowns() {
        if (this.tradedTokens.size === 0) {
            console.log(`📊 Aucun token en cooldown`);
            return;
        }
        
        console.log(`📊 Tokens en cooldown:`);
        
        for (const [tokenAddress, history] of this.tradedTokens.entries()) {
            const timeSinceLastTrade = Date.now() - history.lastTradeTime;
            
            let cooldownTime;
            if (history.lastResult === 'profit') {
                cooldownTime = this.retradeCooldown.afterProfit;
            } else if (history.lastResult === 'loss') {
                cooldownTime = this.retradeCooldown.afterLoss;
            } else {
                cooldownTime = this.retradeCooldown.normal;
            }
            
            const remainingTime = cooldownTime - timeSinceLastTrade;
            
            if (remainingTime > 0) {
                const remainingHours = (remainingTime / (1000 * 60 * 60)).toFixed(1);
                const result = history.lastResult;
                const profit = history.finalProfit ? `${history.finalProfit > 0 ? '+' : ''}${history.finalProfit.toFixed(1)}%` : 'N/A';
                
                console.log(`   🕐 ${tokenAddress.slice(0, 8)}... → ${remainingHours}h (${result}: ${profit})`);
            }
        }
    }

    // LANCEMENT DE L'AUTO-TRADING
    async startAutoTrading() {
        console.log(`🚀 Démarrage Auto-Trading Whitelist DexScreener`);
        console.log(`💼 Wallet: ${this.wallet.publicKey.toString()}`);
        console.log(`💰 Montant par achat: ${this.buyAmount} SOL`);
        console.log(`🎯 Max positions simultanées: ${this.maxConcurrentPositions}`);
        console.log(`🛡️ Source: Whitelist DexScreener Direct`);
        console.log(`⏰ Check positions: Toutes les 2 minutes`);
        console.log(`📊 Scan whitelist: Toutes les 10 minutes`);
        console.log('💡 Appuyez sur Ctrl+C pour arrêter\n');
        
        let scanCount = 0;
        
        // Timer récap performance (toutes les 10 minutes)
        const performanceTimer = setInterval(async () => {
    try {
        await this.sendPerformanceRecapToDiscord();
    } catch (error) {
        console.log('📊 Récap en attente...');
    }
}, 10 * 60 * 1000);
        
        // Timer positions (2 minutes)
        const positionCheckTimer = setInterval(async () => {
            try {
                if (this.positions.size > 0) {
                    console.log(`\n⏰ ${new Date().toLocaleTimeString()} - Check ${this.positions.size} positions`);
                    await this.checkPositions();
                    
                    if (this.positions.size < this.maxConcurrentPositions) {
                        console.log(`💡 Position libre détectée, scan opportuniste...`);
                        const tokens = await this.scanNewTokens();
                        if (tokens.length > 0) {
                            await this.processNewTokens(tokens);
                        }
                    }
                }
            } catch (error) {
                console.error('❌ Erreur check positions:', error.message);
            }
        }, 2 * 60 * 1000);
        
        // Timer scan (10 minutes) 
        const scanTimer = setInterval(async () => {
            try {
                scanCount++;
                console.log(`\n⏰ ${new Date().toLocaleTimeString()} - Scan whitelist #${scanCount}`);
                
                const tokens = await this.scanNewTokens();
                if (tokens.length > 0) {
                    await this.processNewTokens(tokens);
                }
                
                console.log(`📊 Positions: ${this.positions.size}/${this.maxConcurrentPositions}`);
                if (scanCount % 3 === 0) {
                    this.showActiveCooldowns();
                }
            } catch (error) {
                console.error('❌ Erreur scan whitelist:', error.message);
            }
        }, 10 * 60 * 1000);
        
        // Scan initial avec récap
        try {
            console.log(`\n⏰ ${new Date().toLocaleString()} - Scan initial whitelist`);
            const tokens = await this.scanNewTokens();
            if (tokens.length > 0) {
                await this.processNewTokens(tokens);
            }
            
            
            
        } catch (error) {
            console.error('❌ Erreur scan initial:', error.message);
        }
        
        // Gestion arrêt propre
        process.on('SIGINT', () => {
            console.log('\n🛑 Arrêt demandé...');
            clearInterval(positionCheckTimer);
            clearInterval(scanTimer);
            clearInterval(performanceTimer);
            console.log('✅ Timers arrêtés');
            

            
            process.exit(0);
        });
        
        // Boucle principale pour maintenir le processus
        while (true) {
            await new Promise(resolve => setTimeout(resolve, 60000));
        }
    }
}

// FONCTIONS D'UTILISATION
async function runAutoTrader() {
    console.log('🤖 Auto-Trader Jupiter - Ventes Échelonnées');
    console.log('═'.repeat(60));
    
    const trader = new SimpleAutoTrader();
    
    try {
        const isConnected = await trader.initializeDiscord();
        if (!isConnected) {
            console.log('❌ Impossible de se connecter à Discord');
            return;
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const balance = await trader.connection.getBalance(trader.wallet.publicKey);
        const solBalance = balance / 1e9;
        
        console.log(`💰 Solde wallet: ${solBalance.toFixed(4)} SOL`);
        
        if (solBalance < trader.buyAmount * 2) {
            console.log(`⚠️ Solde insuffisant pour trader (minimum: ${trader.buyAmount * 2} SOL)`);
            return;
        }
        
        await trader.startAutoTrading();
        
    } catch (error) {
        console.error('❌ Erreur:', error.message);
    }
}

async function testTrader() {
    console.log('🧪 Test Auto-Trader...');
    
    const trader = new SimpleAutoTrader();
    
    try {
        await trader.initializeDiscord();
        console.log('✅ Discord OK');
        
        const balance = await trader.connection.getBalance(trader.wallet.publicKey);
        console.log(`✅ Solana OK - Balance: ${(balance / 1e9).toFixed(4)} SOL`);
        
        const tokens = await trader.scanNewTokens();
        console.log(`✅ Scan OK - ${tokens.length} tokens trouvés`);
        
        console.log('\n🎯 Configuration ventes échelonnées:');
        trader.sellLevels.forEach((level, i) => {
            console.log(`   ${i + 1}. +${level.profit}% → Vendre ${level.percentage}% (${level.reason})`);
        });
        
        console.log(`\n🛡️ Protections:`);
        console.log(`   📉 Stop-Loss: -${trader.stopLossPercent}%`);
        console.log(`   📈 Trailing Stop: -${trader.trailingStopPercent}%`);
        
        console.log('\n🎉 Tous les tests réussis !');
        
    } catch (error) {
        console.error('❌ Erreur test:', error.message);
    }
}

module.exports = { SimpleAutoTrader, runAutoTrader, testTrader };

// SERVEUR WEB POUR RENDER
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.json({
        status: 'Bot Jupiter Auto-Trader actif! 🚀',
        uptime: process.uptime(),
        lastScan: new Date().toISOString()
    });
});

app.get('/stats', (req, res) => {
    res.json({
        bot: 'Jupiter Auto-Trader',
        status: 'running',
        scans: 'Whitelist toutes les 10 minutes'
    });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`🌐 Serveur web actif sur port ${port}`);
});

// EXÉCUTION
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
        console.log('  +20%  → Vendre 50% (sécurisation rapide)');
        console.log('  +75%  → Vendre 60% du restant');
        console.log('  +200% → Vendre 75% du restant');
        console.log('  +500% → Vendre 90% du restant');
        console.log('  Stop-Loss: -20% | Trailing: -15%');
        console.log('');
        
        runAutoTrader();
    }
}