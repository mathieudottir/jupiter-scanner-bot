// debug_scanner.js - Scanner isolé pour comprendre les résultats
require('dotenv').config();

class DebugScanner {
    constructor() {
        // Configuration identique au trader
        this.maxAgeHours = 1;
        this.minLiquidity = 5000;
        this.minVolume = 10000;
        this.minChange = 20;
        
        // Configuration élargie pour debug
        this.debugMaxAgeHours = 48; // Plus large pour debug
        this.debugMinLiquidity = 1000; // Plus bas pour debug
        this.debugMinVolume = 1000; // Plus bas pour debug
        this.debugMinChange = 5; // Plus bas pour debug
        
        console.log('🔍 DEBUG SCANNER - Configuration:');
        console.log(`   📅 Âge max: ${this.maxAgeHours}h (debug: ${this.debugMaxAgeHours}h)`);
        console.log(`   💧 Liquidité min: $${this.minLiquidity} (debug: $${this.debugMinLiquidity})`);
        console.log(`   📊 Volume min: $${this.minVolume} (debug: $${this.debugMinVolume})`);
        console.log(`   📈 Change min: ${this.minChange}% (debug: ${this.debugMinChange}%)`);
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

    // Analyser un token en détail
    analyzeToken(token, source) {
        const age = this.calculateAge(token.pairCreatedAt);
        const liquidity = parseFloat(token.liquidity?.usd || 0);
        const volume24h = parseFloat(token.volume?.h24 || 0);
        const change24h = parseFloat(token.priceChange?.h24 || 0);
        const change6h = parseFloat(token.priceChange?.h6 || 0);
        const change1h = parseFloat(token.priceChange?.h1 || 0);
        
        const analysis = {
            source,
            symbol: token.baseToken?.symbol || 'N/A',
            name: token.baseToken?.name || 'N/A',
            address: token.baseToken?.address || 'N/A',
            age: age ? age.toFixed(1) : 'N/A',
            liquidity: liquidity,
            volume24h: volume24h,
            change24h: change24h,
            change6h: change6h,
            change1h: change1h,
            chainId: token.chainId,
            
            // Tests de validation
            validChain: token.chainId === 'solana',
            validAge: age && age <= this.maxAgeHours,
            validLiquidity: liquidity >= this.minLiquidity,
            validVolume: volume24h >= this.minVolume,
            validChange: change24h >= this.minChange,
            
            // Tests debug (critères assouplis)
            debugAge: age && age <= this.debugMaxAgeHours,
            debugLiquidity: liquidity >= this.debugMinLiquidity,
            debugVolume: volume24h >= this.debugMinVolume,
            debugChange: change24h >= this.debugMinChange,
            
            // Score final
            passesOriginal: false,
            passesDebug: false
        };
        
        // Validation finale
        analysis.passesOriginal = analysis.validChain && 
                                analysis.validAge && 
                                analysis.validLiquidity && 
                                analysis.validVolume && 
                                analysis.validChange;
                                
        analysis.passesDebug = analysis.validChain && 
                             analysis.debugAge && 
                             analysis.debugLiquidity && 
                             analysis.debugVolume && 
                             analysis.debugChange;
        
        return analysis;
    }

    // Afficher l'analyse d'un token
    displayAnalysis(analysis) {
        const status = analysis.passesOriginal ? '✅ PASS' : '❌ FAIL';
        const debugStatus = analysis.passesDebug ? '✅ DEBUG' : '❌ DEBUG';
        
        console.log(`\n📊 ${analysis.symbol} (${analysis.source}) - ${status} | ${debugStatus}`);
        console.log(`   📍 Adresse: ${analysis.address.slice(0, 8)}...`);
        console.log(`   🏷️  Nom: ${analysis.name}`);
        console.log(`   ⛓️  Chain: ${analysis.chainId} ${analysis.validChain ? '✅' : '❌'}`);
        console.log(`   📅 Âge: ${analysis.age}h ${analysis.validAge ? '✅' : '❌'} (debug: ${analysis.debugAge ? '✅' : '❌'})`);
        console.log(`   💧 Liquidité: $${analysis.liquidity.toLocaleString()} ${analysis.validLiquidity ? '✅' : '❌'} (debug: ${analysis.debugLiquidity ? '✅' : '❌'})`);
        console.log(`   📊 Volume 24h: $${analysis.volume24h.toLocaleString()} ${analysis.validVolume ? '✅' : '❌'} (debug: ${analysis.debugVolume ? '✅' : '❌'})`);
        console.log(`   📈 Change 24h: ${analysis.change24h}% ${analysis.validChange ? '✅' : '❌'} (debug: ${analysis.debugChange ? '✅' : '❌'})`);
        console.log(`   📈 Change 6h: ${analysis.change6h}%`);
        console.log(`   📈 Change 1h: ${analysis.change1h}%`);
        
        // Raisons d'échec
        if (!analysis.passesOriginal) {
            const reasons = [];
            if (!analysis.validChain) reasons.push('❌ Pas Solana');
            if (!analysis.validAge) reasons.push(`❌ Âge: ${analysis.age}h > ${this.maxAgeHours}h`);
            if (!analysis.validLiquidity) reasons.push(`❌ Liquidité: $${analysis.liquidity} < $${this.minLiquidity}`);
            if (!analysis.validVolume) reasons.push(`❌ Volume: $${analysis.volume24h} < $${this.minVolume}`);
            if (!analysis.validChange) reasons.push(`❌ Change: ${analysis.change24h}% < ${this.minChange}%`);
            console.log(`   🚫 Raisons d'échec: ${reasons.join(', ')}`);
        }
    }

    // Scanner 1: Tokens trending récents
    async scanTrendingTokens() {
        console.log('\n🔍 SCAN 1: Tokens Trending Récents');
        console.log('═'.repeat(50));
        
        const results = [];
        
        try {
            const response = await fetch('https://api.dexscreener.com/token-profiles/latest/v1');
            
            if (!response.ok) {
                console.log(`❌ Erreur API: ${response.status}`);
                return results;
            }
            
            const data = await response.json();
            console.log(`📡 Reçu ${data.length} token profiles`);
            
            let processedCount = 0;
            const maxProcess = 20; // Analyser plus de tokens pour debug
            
            for (const tokenProfile of data.slice(0, maxProcess)) {
                try {
                    if (!tokenProfile.tokenAddress) continue;
                    
                    console.log(`\n🔄 Traitement ${++processedCount}/${maxProcess}: ${tokenProfile.tokenAddress.slice(0, 8)}...`);
                    
                    const pairsResponse = await fetch(
                        `https://api.dexscreener.com/latest/dex/tokens/${tokenProfile.tokenAddress}`
                    );
                    
                    if (pairsResponse.ok) {
                        const pairsData = await pairsResponse.json();
                        
                        if (pairsData.pairs && pairsData.pairs.length > 0) {
                            console.log(`   📊 Trouvé ${pairsData.pairs.length} paires`);
                            
                            for (const pair of pairsData.pairs) {
                                const analysis = this.analyzeToken(pair, 'TRENDING');
                                this.displayAnalysis(analysis);
                                results.push(analysis);
                            }
                        } else {
                            console.log(`   ❌ Aucune paire trouvée`);
                        }
                    } else {
                        console.log(`   ❌ Erreur API pairs: ${pairsResponse.status}`);
                    }
                    
                    // Rate limiting
                    await new Promise(resolve => setTimeout(resolve, 500));
                    
                } catch (error) {
                    console.log(`   ❌ Erreur: ${error.message}`);
                }
            }
            
        } catch (error) {
            console.error('❌ Erreur scan trending:', error.message);
        }
        
        return results;
    }

    // Scanner 2: Recherche générale Solana
    async scanGeneralSolana() {
        console.log('\n🔍 SCAN 2: Recherche Générale Solana');
        console.log('═'.repeat(50));
        
        const results = [];
        
        try {
            const response = await fetch('https://api.dexscreener.com/latest/dex/search?q=solana');
            
            if (!response.ok) {
                console.log(`❌ Erreur API: ${response.status}`);
                return results;
            }
            
            const data = await response.json();
            console.log(`📡 Reçu ${data.pairs?.length || 0} paires`);
            
            if (data.pairs) {
                const maxAnalyze = 30; // Analyser plus de paires
                
                for (let i = 0; i < Math.min(data.pairs.length, maxAnalyze); i++) {
                    const pair = data.pairs[i];
                    const analysis = this.analyzeToken(pair, 'GENERAL');
                    this.displayAnalysis(analysis);
                    results.push(analysis);
                }
            }
            
        } catch (error) {
            console.error('❌ Erreur scan général:', error.message);
        }
        
        return results;
    }

    // Scanner 3: Tokens spécifiques Solana
    async scanSolanaSpecific() {
        console.log('\n🔍 SCAN 3: Tokens Solana Spécifiques');
        console.log('═'.repeat(50));
        
        const results = [];
        
        try {
            // Essayer différents endpoints
            const endpoints = [
                'https://api.dexscreener.com/latest/dex/tokens/solana',
                'https://api.dexscreener.com/latest/dex/pairs/solana'
            ];
            
            for (const endpoint of endpoints) {
                try {
                    console.log(`\n🔗 Test endpoint: ${endpoint}`);
                    const response = await fetch(endpoint);
                    
                    if (response.ok) {
                        const data = await response.json();
                        console.log(`✅ Endpoint OK - Données reçues:`, typeof data);
                        
                        if (data.pairs) {
                            console.log(`📊 ${data.pairs.length} paires trouvées`);
                            
                            for (let i = 0; i < Math.min(data.pairs.length, 10); i++) {
                                const pair = data.pairs[i];
                                const analysis = this.analyzeToken(pair, 'SOLANA-SPECIFIC');
                                this.displayAnalysis(analysis);
                                results.push(analysis);
                            }
                        }
                    } else {
                        console.log(`❌ Endpoint failed: ${response.status}`);
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    
                } catch (error) {
                    console.log(`❌ Erreur endpoint: ${error.message}`);
                }
            }
            
        } catch (error) {
            console.error('❌ Erreur scan Solana:', error.message);
        }
        
        return results;
    }

    // Analyser tous les résultats
    analyzeResults(allResults) {
        console.log('\n📊 ANALYSE GLOBALE DES RÉSULTATS');
        console.log('═'.repeat(50));
        
        const stats = {
            total: allResults.length,
            passOriginal: allResults.filter(r => r.passesOriginal).length,
            passDebug: allResults.filter(r => r.passesDebug).length,
            bySource: {},
            failureReasons: {
                chain: allResults.filter(r => !r.validChain).length,
                age: allResults.filter(r => !r.validAge).length,
                liquidity: allResults.filter(r => !r.validLiquidity).length,
                volume: allResults.filter(r => !r.validVolume).length,
                change: allResults.filter(r => !r.validChange).length
            }
        };
        
        // Stats par source
        allResults.forEach(r => {
            if (!stats.bySource[r.source]) stats.bySource[r.source] = 0;
            stats.bySource[r.source]++;
        });
        
        console.log(`📈 Total tokens analysés: ${stats.total}`);
        console.log(`✅ Passent critères originaux: ${stats.passOriginal}`);
        console.log(`🔧 Passent critères debug: ${stats.passDebug}`);
        
        console.log('\n📊 Par source:');
        Object.entries(stats.bySource).forEach(([source, count]) => {
            console.log(`   ${source}: ${count} tokens`);
        });
        
        console.log('\n❌ Raisons d\'échec:');
        console.log(`   🚫 Pas Solana: ${stats.failureReasons.chain}`);
        console.log(`   ⏰ Âge trop élevé: ${stats.failureReasons.age}`);
        console.log(`   💧 Liquidité trop faible: ${stats.failureReasons.liquidity}`);
        console.log(`   📊 Volume trop faible: ${stats.failureReasons.volume}`);
        console.log(`   📈 Change trop faible: ${stats.failureReasons.change}`);
        
        // Tokens qui passent
        const passing = allResults.filter(r => r.passesOriginal);
        if (passing.length > 0) {
            console.log('\n✅ TOKENS QUI PASSENT:');
            passing.forEach(token => {
                console.log(`   🎯 ${token.symbol} - ${token.source} - ${token.age}h, $${token.liquidity.toLocaleString()}, +${token.change24h}%`);
            });
        }
        
        // Suggestions
        console.log('\n💡 SUGGESTIONS:');
        if (stats.failureReasons.age > stats.total * 0.5) {
            console.log(`   📅 Beaucoup de tokens trop vieux (${stats.failureReasons.age}/${stats.total})`);
            console.log(`   💡 Considérer augmenter maxAgeHours de ${this.maxAgeHours}h à ${this.debugMaxAgeHours}h`);
        }
        
        if (stats.failureReasons.liquidity > stats.total * 0.3) {
            console.log(`   💧 Beaucoup de liquidité trop faible (${stats.failureReasons.liquidity}/${stats.total})`);
            console.log(`   💡 Considérer réduire minLiquidity de $${this.minLiquidity} à $${this.debugMinLiquidity}`);
        }
        
        if (stats.failureReasons.volume > stats.total * 0.3) {
            console.log(`   📊 Beaucoup de volume trop faible (${stats.failureReasons.volume}/${stats.total})`);
            console.log(`   💡 Considérer réduire minVolume de $${this.minVolume} à $${this.debugMinVolume}`);
        }
        
        if (stats.failureReasons.change > stats.total * 0.3) {
            console.log(`   📈 Beaucoup de change trop faible (${stats.failureReasons.change}/${stats.total})`);
            console.log(`   💡 Considérer réduire minChange de ${this.minChange}% à ${this.debugMinChange}%`);
        }
    }

    // Fonction principale
    async runDebugScan() {
        console.log('🚀 DÉMARRAGE DEBUG SCANNER');
        console.log('═'.repeat(60));
        
        const allResults = [];
        
        // Lancer tous les scans
        const trending = await this.scanTrendingTokens();
        allResults.push(...trending);
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const general = await this.scanGeneralSolana();
        allResults.push(...general);
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const specific = await this.scanSolanaSpecific();
        allResults.push(...specific);
        
        // Analyser les résultats
        this.analyzeResults(allResults);
        
        console.log('\n🎉 DEBUG SCAN TERMINÉ');
        return allResults;
    }
}

// Fonction pour lancer le debug
async function runDebugScan() {
    const scanner = new DebugScanner();
    await scanner.runDebugScan();
}

// Exécution si lancé directement
if (require.main === module) {
    runDebugScan().catch(error => {
        console.error('❌ Erreur debug:', error);
    });
}

module.exports = { DebugScanner, runDebugScan };