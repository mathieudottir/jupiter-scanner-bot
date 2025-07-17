// discord_scanner.js - Scanner pour nouveaux tokens Jupiter avec notification Discord
require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

class DiscordJupiterScanner {
    constructor() {
        this.discordToken = process.env.DISCORD_TOKEN;
        this.channelId = process.env.DISCORD_CHANNEL_ID;
        this.client = new Client({ 
            intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] 
        });
        
        // Stockage avancé des tokens déjà postés pour éviter les doublons
        this.postedTokens = new Map(); // Map avec timestamp de post
        this.tokenCooldown = 24 * 60 * 60 * 1000; // 24h en millisecondes
        
        // Critères de filtrage
        this.maxAgeHours = 1; // Maximum 1 heure
        this.minLiquidity = 5000; // Minimum $5k liquidité
        this.minVolume = 10000; // Minimum $10k volume 24h
        this.minChange = 20; // Minimum +20% en 24h
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

    // Scanner les nouveaux tokens sur DexScreener
    async scanNewTokens() {
        console.log('🔍 Recherche de nouveaux tokens...');
        
        try {
            const newTokens = [];
            
            // 1. Récupérer les tokens trending récents
            const trendingResponse = await fetch('https://api.dexscreener.com/token-profiles/latest/v1');
            
            if (trendingResponse.ok) {
                const trendingData = await trendingResponse.json();
                
                for (const tokenProfile of trendingData.slice(0, 15)) {
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
                        console.log(`⚠️ Erreur token ${tokenProfile.tokenAddress}: ${error.message}`);
                    }
                }
            }
            
            // 2. Recherche directe de nouveaux tokens
            const searchQueries = ['new', 'launch', 'created'];
            
            for (const query of searchQueries) {
                try {
                    const searchResponse = await fetch(
                        `https://api.dexscreener.com/latest/dex/search/?q=${query}`
                    );
                    
                    if (searchResponse.ok) {
                        const searchData = await searchResponse.json();
                        
                        if (searchData.pairs) {
                            const filteredTokens = searchData.pairs.filter(pair => {
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
                            
                            newTokens.push(...filteredTokens.slice(0, 5));
                        }
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, 500));
                } catch (error) {
                    console.log(`⚠️ Erreur recherche ${query}: ${error.message}`);
                }
            }
            
            // Dédupliquer par adresse
            const uniqueTokens = new Map();
            for (const token of newTokens) {
                const address = token.baseToken?.address;
                if (address && !uniqueTokens.has(address)) {
                    uniqueTokens.set(address, token);
                }
            }
            
            const finalTokens = Array.from(uniqueTokens.values())
                .sort((a, b) => {
                    const ageA = this.calculateAge(a.pairCreatedAt);
                    const ageB = this.calculateAge(b.pairCreatedAt);
                    return ageA - ageB; // Plus récent en premier
                })
                .slice(0, 5); // Max 5 tokens
            
            console.log(`✅ ${finalTokens.length} nouveaux tokens trouvés`);
            return finalTokens;
            
        } catch (error) {
            console.error('❌ Erreur scan nouveaux tokens:', error.message);
            return [];
        }
    }

    // Calculer l'âge du token en heures
    calculateAge(createdAt) {
        if (!createdAt) return null;
        try {
            return (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60);
        } catch {
            return null;
        }
    }

    // Tester la compatibilité Jupiter
    async testJupiterCompatibility(tokenAddress) {
        try {
            console.log(`   🧪 Test Jupiter: ${tokenAddress.slice(0, 8)}...`);
            
            const response = await fetch(
                `https://quote-api.jup.ag/v6/quote?` +
                `inputMint=So11111111111111111111111111111111111111112&` +
                `outputMint=${tokenAddress}&` +
                `amount=1000000&` +
                `slippageBps=1000`,
                { 
                    timeout: 8000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (compatible; TradingBot/1.0)'
                    }
                }
            );
            
            if (response.ok) {
                const quote = await response.json();
                if (!quote.error && quote.outAmount && parseFloat(quote.outAmount) > 0) {
                    console.log(`   ✅ Jupiter compatible: ${tokenAddress.slice(0, 8)}...`);
                    return true;
                }
            }
            
            console.log(`   ❌ Jupiter non compatible: ${tokenAddress.slice(0, 8)}...`);
            return false;
            
        } catch (error) {
            console.log(`   ❌ Erreur test Jupiter: ${error.message}`);
            return false;
        }
    }

    // Créer un embed Discord optimisé mobile
    createTokenEmbed(tokenData) {
        const token = tokenData.baseToken;
        const age = this.calculateAge(tokenData.pairCreatedAt);
        const priceChange24h = parseFloat(tokenData.priceChange?.h24 || 0);
        const priceChange1h = parseFloat(tokenData.priceChange?.h1 || 0);
        const volume24h = parseFloat(tokenData.volume?.h24 || 0);
        const liquidity = parseFloat(tokenData.liquidity?.usd || 0);
        const price = parseFloat(tokenData.priceUsd || 0);
        
        // Emoji pour le trending
        let emoji = '🆕';
        if (priceChange24h > 500) emoji = '🚀';
        else if (priceChange24h > 200) emoji = '🔥';
        else if (priceChange24h > 100) emoji = '⚡';
        else if (priceChange24h > 50) emoji = '📈';
        
        // Couleur selon performance
        let color = 0x00ff00; // Vert
        if (priceChange24h > 200) color = 0xff0000; // Rouge pour mega pump
        else if (priceChange24h > 100) color = 0xff8800; // Orange
        else if (priceChange24h > 50) color = 0x00ff88; // Vert clair
        
        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(`${emoji} ${token.symbol} - NOUVEAU TOKEN JUPITER`)
            .setDescription(`**${token.name || token.symbol}**`)
            .addFields(
                {
                    name: '💰 Prix',
                    value: `$${price.toFixed(price < 0.01 ? 6 : 4)}`,
                    inline: true
                },
                {
                    name: '📈 24H',
                    value: `+${priceChange24h.toFixed(1)}%`,
                    inline: true
                },
                {
                    name: '⚡ 1H',
                    value: `${priceChange1h >= 0 ? '+' : ''}${priceChange1h.toFixed(1)}%`,
                    inline: true
                },
                {
                    name: '💧 Liquidité',
                    value: `$${liquidity.toLocaleString()}`,
                    inline: true
                },
                {
                    name: '📊 Volume 24H',
                    value: `$${volume24h.toLocaleString()}`,
                    inline: true
                },
                {
                    name: '⏰ Âge',
                    value: `${age ? age.toFixed(1) : '?'}h`,
                    inline: true
                }
            )
            .addFields(
                {
                    name: '📍 Adresse du Token',
                    value: `\`${token.address}\``,
                    inline: false
                },
                {
                    name: '🔗 Liens Rapides',
                    value: `[📊 DexScreener](${tokenData.url || `https://dexscreener.com/solana/${token.address}`}) | [🚀 Jupiter](https://jup.ag/swap/SOL-${token.address}) | [📋 Copier Adresse](https://solscan.io/token/${token.address})`,
                    inline: false
                }
            )
            .setFooter({ 
                text: `🟢 Compatible Jupiter • Trouvé à ${new Date().toLocaleTimeString()}` 
            })
            .setTimestamp();
        
        return embed;
    }

    // Poster sur Discord
    async postToDiscord(tokenData) {
        try {
            const channel = await this.client.channels.fetch(this.channelId);
            
            if (!channel) {
                console.error('❌ Canal Discord introuvable');
                return false;
            }
            
            const embed = this.createTokenEmbed(tokenData);
            
            // Message d'alerte pour mobile
            const alertMessage = `🚨 **NOUVEAU TOKEN JUPITER** 🚨\n` +
                                `${tokenData.baseToken.symbol} • +${parseFloat(tokenData.priceChange?.h24 || 0).toFixed(1)}% • ` +
                                `$${parseFloat(tokenData.liquidity?.usd || 0).toLocaleString()} liquidité`;
            
            await channel.send({
                content: alertMessage,
                embeds: [embed]
            });
            
            console.log(`📤 Token posté sur Discord: ${tokenData.baseToken.symbol}`);
            return true;
            
        } catch (error) {
            console.error('❌ Erreur post Discord:', error.message);
            return false;
        }
    }

    // Vérifier si un token a déjà été posté récemment
    isTokenAlreadyPosted(tokenAddress) {
        if (!this.postedTokens.has(tokenAddress)) {
            return false;
        }
        
        const lastPosted = this.postedTokens.get(tokenAddress);
        const timeSincePosted = Date.now() - lastPosted;
        
        // Si le token a été posté il y a plus de 24h, on peut le reposter
        if (timeSincePosted > this.tokenCooldown) {
            this.postedTokens.delete(tokenAddress);
            return false;
        }
        
        return true;
    }

    // Marquer un token comme posté
    markTokenAsPosted(tokenAddress) {
        this.postedTokens.set(tokenAddress, Date.now());
        
        // Nettoyer les anciens tokens (plus de 24h) pour économiser la mémoire
        if (this.postedTokens.size > 200) {
            const now = Date.now();
            for (const [address, timestamp] of this.postedTokens.entries()) {
                if (now - timestamp > this.tokenCooldown) {
                    this.postedTokens.delete(address);
                }
            }
        }
    }

    // Obtenir les statistiques des tokens postés
    getPostedTokensStats() {
        const now = Date.now();
        const recent = Array.from(this.postedTokens.values()).filter(
            timestamp => now - timestamp < 3600000 // 1 heure
        ).length;
        
        return {
            total: this.postedTokens.size,
            lastHour: recent
        };
    }

    // Traiter et poster les tokens valides
    async processAndPost(tokens) {
        console.log(`🔄 Traitement de ${tokens.length} tokens...`);
        
        let postedCount = 0;
        let skippedCount = 0;
        
        for (const token of tokens) {
            try {
                const tokenAddress = token.baseToken?.address;
                
                if (!tokenAddress) continue;
                
                // Vérifier si déjà posté récemment (protection anti-spam améliorée)
                if (this.isTokenAlreadyPosted(tokenAddress)) {
                    const lastPosted = this.postedTokens.get(tokenAddress);
                    const hoursAgo = ((Date.now() - lastPosted) / (1000 * 60 * 60)).toFixed(1);
                    console.log(`⏭️ Token déjà posté il y a ${hoursAgo}h: ${token.baseToken.symbol}`);
                    skippedCount++;
                    continue;
                }
                
                // Tester la compatibilité Jupiter
                const isJupiterCompatible = await this.testJupiterCompatibility(tokenAddress);
                
                if (!isJupiterCompatible) {
                    console.log(`❌ Non compatible Jupiter: ${token.baseToken.symbol}`);
                    continue;
                }
                
                // Poster sur Discord
                const posted = await this.postToDiscord(token);
                
                if (posted) {
                    this.markTokenAsPosted(tokenAddress);
                    postedCount++;
                    
                    console.log(`📤 ✅ Token posté: ${token.baseToken.symbol} (${tokenAddress.slice(0, 8)}...)`);
                } else {
                    console.log(`❌ Échec post Discord: ${token.baseToken.symbol}`);
                }
                
                // Rate limiting entre posts (éviter le spam)
                await new Promise(resolve => setTimeout(resolve, 2000));
                
            } catch (error) {
                console.log(`❌ Erreur traitement ${token.baseToken?.symbol}: ${error.message}`);
            }
        }
        
        // Afficher les statistiques
        const stats = this.getPostedTokensStats();
        console.log(`✅ ${postedCount} tokens postés, ${skippedCount} ignorés (doublons)`);
        console.log(`📊 Stats: ${stats.total} tokens en mémoire, ${stats.lastHour} postés dernière heure`);
        
        return postedCount;
    }

    // Fonction principale de scan
    async runScan() {
        console.log('\n🔍 SCAN NOUVEAUX TOKENS JUPITER');
        console.log('═'.repeat(50));
        
        try {
            // 1. Scanner les nouveaux tokens
            const tokens = await this.scanNewTokens();
            
            if (tokens.length === 0) {
                console.log('⚠️ Aucun nouveau token trouvé');
                return 0;
            }
            
            // 2. Traiter et poster
            const postedCount = await this.processAndPost(tokens);
            
            console.log(`\n📊 Résumé: ${postedCount} tokens postés sur ${tokens.length} trouvés`);
            return postedCount;
            
        } catch (error) {
            console.error('❌ Erreur scan général:', error.message);
            return 0;
        }
    }

    // Scan en continu
    async startContinuousScanning(intervalMinutes = 5) {
        console.log(`🔄 Démarrage scan continu (toutes les ${intervalMinutes} minutes)`);
        console.log('🎯 Focus: Nouveaux tokens < 1h compatibles Jupiter');
        console.log('📱 Optimisé pour trading mobile');
        console.log('💡 Appuyez sur Ctrl+C pour arrêter\n');
        
        let scanCount = 0;
        let totalPosted = 0;
        
        while (true) {
            try {
                scanCount++;
                console.log(`\n⏰ ${new Date().toLocaleString()} - Scan #${scanCount}`);
                
                const posted = await this.runScan();
                totalPosted += posted;
                
                const stats = this.getPostedTokensStats();
                console.log(`📈 Stats globales: ${totalPosted} tokens postés en ${scanCount} scans`);
                console.log(`🧠 Mémoire: ${stats.total} tokens trackés, ${stats.lastHour} postés dernière heure`);
                console.log(`⏳ Prochain scan dans ${intervalMinutes} minutes...`);
                
                await new Promise(resolve => setTimeout(resolve, intervalMinutes * 60 * 1000));
                
            } catch (error) {
                console.error('❌ Erreur scan continu:', error.message);
                console.log('🔄 Reprise dans 2 minutes...');
                await new Promise(resolve => setTimeout(resolve, 2 * 60 * 1000));
            }
        }
    }
}

// Fonctions d'utilisation
async function runSingleScan() {
    console.log('🤖 Scanner Discord - Nouveaux Tokens Jupiter');
    console.log('═'.repeat(50));
    
    const scanner = new DiscordJupiterScanner();
    
    try {
        // Initialiser Discord
        const isConnected = await scanner.initializeDiscord();
        if (!isConnected) {
            console.log('❌ Impossible de se connecter à Discord');
            return;
        }
        
        // Attendre un peu pour la connexion
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Lancer le scan
        await scanner.runScan();
        
        console.log('\n✅ Scan terminé !');
        
    } catch (error) {
        console.error('❌ Erreur:', error.message);
    } finally {
        scanner.client.destroy();
    }
}

async function runContinuousScanning(intervalMinutes = 5) {
    const scanner = new DiscordJupiterScanner();
    
    try {
        // Initialiser Discord
        const isConnected = await scanner.initializeDiscord();
        if (!isConnected) {
            console.log('❌ Impossible de se connecter à Discord');
            return;
        }
        
        // Attendre un peu pour la connexion
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Lancer le scan continu
        await scanner.startContinuousScanning(intervalMinutes);
        
    } catch (error) {
        console.error('❌ Erreur:', error.message);
    }
}

async function testConfiguration() {
    console.log('🧪 Test de configuration...');
    
    const scanner = new DiscordJupiterScanner();
    
    // Vérifier les variables d'environnement
    if (!scanner.discordToken) {
        console.log('❌ DISCORD_TOKEN manquant dans .env');
        return false;
    }
    
    if (!scanner.channelId) {
        console.log('❌ DISCORD_CHANNEL_ID manquant dans .env');
        return false;
    }
    
    console.log('✅ Variables d\'environnement OK');
    
    // Tester Discord
    try {
        const isConnected = await scanner.initializeDiscord();
        if (isConnected) {
            console.log('✅ Connexion Discord OK');
            
            // Tester le canal
            await new Promise(resolve => setTimeout(resolve, 2000));
            const channel = await scanner.client.channels.fetch(scanner.channelId);
            
            if (channel) {
                console.log(`✅ Canal Discord trouvé: ${channel.name}`);
            } else {
                console.log('❌ Canal Discord introuvable');
                return false;
            }
            
            scanner.client.destroy();
        } else {
            return false;
        }
    } catch (error) {
        console.log('❌ Erreur test Discord:', error.message);
        return false;
    }
    
    // Tester DexScreener API
    try {
        console.log('🧪 Test DexScreener API...');
        const response = await fetch('https://api.dexscreener.com/token-profiles/latest/v1');
        if (response.ok) {
            console.log('✅ DexScreener API OK');
        } else {
            console.log('❌ DexScreener API erreur');
            return false;
        }
    } catch (error) {
        console.log('❌ Erreur DexScreener:', error.message);
        return false;
    }
    
    // Tester Jupiter API
    try {
        console.log('🧪 Test Jupiter API...');
        const response = await fetch(
            'https://quote-api.jup.ag/v6/quote?' +
            'inputMint=So11111111111111111111111111111111111111112&' +
            'outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&' +
            'amount=1000000&slippageBps=1000'
        );
        if (response.ok) {
            console.log('✅ Jupiter API OK');
        } else {
            console.log('❌ Jupiter API erreur');
            return false;
        }
    } catch (error) {
        console.log('❌ Erreur Jupiter:', error.message);
        return false;
    }
    
    console.log('\n🎉 Tous les tests réussis !');
    return true;
}

module.exports = { 
    DiscordJupiterScanner, 
    runSingleScan, 
    runContinuousScanning, 
    testConfiguration 
};

// Exécution si lancé directement
if (require.main === module) {
    const args = process.argv.slice(2);
    
    if (args.includes('--test')) {
        testConfiguration();
    } else if (args.includes('--continuous')) {
        const interval = parseInt(args[args.indexOf('--continuous') + 1]) || 5;
        runContinuousScanning(interval);
    } else {
        console.log('🎯 Discord Scanner - Nouveaux Tokens Jupiter');
        console.log('═'.repeat(50));
        console.log('Usage:');
        console.log('  node discord_scanner.js              - Scan unique');
        console.log('  node discord_scanner.js --continuous [min] - Scan continu (défaut: 5min)');
        console.log('  node discord_scanner.js --test       - Tester la config');
        console.log('');
        console.log('Variables .env requises:');
        console.log('  DISCORD_TOKEN=your_bot_token');
        console.log('  DISCORD_CHANNEL_ID=your_channel_id');
        console.log('');
        
        runSingleScan();
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
