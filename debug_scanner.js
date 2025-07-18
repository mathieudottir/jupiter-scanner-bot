// solana_focused_scanner.js - Scanner 100% Solana avec tokens établis
require('dotenv').config();

class SolanaFocusedScanner {
    constructor() {
        // Configuration élargie pour inclure tokens établis
        this.criteria = {
            // Nouveaux tokens (< 6h)
            fresh: {
                maxAge: 6, // 6h au lieu de 1h
                minLiquidity: 5000,
                minVolume: 10000,
                minChange24h: 20,
                label: '🆕 Fresh'
            },
            
            // Tokens établis performants (6h - 7 jours)
            established: {
                maxAge: 7 * 24, // 7 jours
                minLiquidity: 50000, // Plus de liquidité requise
                minVolume: 100000, // Plus de volume requis
                minChange24h: 15, // Change plus bas OK
                minChange1h: 3, // Momentum récent requis
                label: '🏆 Established'
            },
            
            // Tokens momentum (peu importe l'âge)
            momentum: {
                maxAge: 30 * 24, // 30 jours max
                minLiquidity: 100000, // Forte liquidité
                minVolume: 500000, // Très fort volume
                minChange1h: 5, // Fort momentum 1h
                minChange6h: 10, // Fort momentum 6h
                label: '🚀 Momentum'
            },
            
            // Tokens "Blue Chip" meme (BONK, WIF, etc.)
            blueChip: {
                maxAge: 365 * 24, // Peu importe l'âge
                minLiquidity: 1000000, // 1M+ liquidité
                minVolume: 1000000, // 1M+ volume
                minChange24h: 5, // Même petit change OK
                popularSymbols: ['BONK', 'WIF', 'POPCAT', 'TRUMP', 'PEPE', 'MOODENG', 'GOAT', 'PNUT', 'BOME'],
                label: '💎 Blue Chip'
            }
        };
        
        console.log('🎯 SCANNER SOLANA FOCUS - Configuration:');
        console.log('   🆕 Fresh: <6h, $5k+ liq, $10k+ vol, +20% change');
        console.log('   🏆 Established: <7j, $50k+ liq, $100k+ vol, +15% change, +3% 1h');
        console.log('   🚀 Momentum: <30j, $100k+ liq, $500k+ vol, +5% 1h, +10% 6h');
        console.log('   💎 Blue Chip: Popular tokens, $1M+ liq/vol, +5% change');
    }

    calculateAge(createdAt) {
        if (!createdAt) return null;
        try {
            return (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60);
        } catch {
            return null;
        }
    }

    // Analyser un token selon tous les critères
    analyzeToken(token, source) {
        const age = this.calculateAge(token.pairCreatedAt);
        const liquidity = parseFloat(token.liquidity?.usd || 0);
        const volume24h = parseFloat(token.volume?.h24 || 0);
        const change24h = parseFloat(token.priceChange?.h24 || 0);
        const change6h = parseFloat(token.priceChange?.h6 || 0);
        const change1h = parseFloat(token.priceChange?.h1 || 0);
        const symbol = token.baseToken?.symbol || '';
        
        const analysis = {
            source,
            symbol,
            name: token.baseToken?.name || 'N/A',
            address: token.baseToken?.address || 'N/A',
            age: age ? age.toFixed(1) : 'N/A',
            liquidity,
            volume24h,
            change24h,
            change6h,
            change1h,
            
            // Test chaque catégorie
            categories: []
        };
        
        // Test Fresh
        if (token.chainId === 'solana' && age && age <= this.criteria.fresh.maxAge) {
            const passes = liquidity >= this.criteria.fresh.minLiquidity &&
                          volume24h >= this.criteria.fresh.minVolume &&
                          change24h >= this.criteria.fresh.minChange24h;
            
            if (passes) {
                analysis.categories.push({
                    type: 'fresh',
                    label: this.criteria.fresh.label,
                    score: change24h + (change6h || 0) + (change1h || 0)
                });
            }
        }
        
        // Test Established
        if (token.chainId === 'solana' && age && age > this.criteria.fresh.maxAge && age <= this.criteria.established.maxAge) {
            const passes = liquidity >= this.criteria.established.minLiquidity &&
                          volume24h >= this.criteria.established.minVolume &&
                          change24h >= this.criteria.established.minChange24h &&
                          change1h >= this.criteria.established.minChange1h;
            
            if (passes) {
                analysis.categories.push({
                    type: 'established',
                    label: this.criteria.established.label,
                    score: change24h + (change6h || 0) * 1.5 + (change1h || 0) * 2
                });
            }
        }
        
        // Test Momentum
        if (token.chainId === 'solana' && age && age <= this.criteria.momentum.maxAge) {
            const passes = liquidity >= this.criteria.momentum.minLiquidity &&
                          volume24h >= this.criteria.momentum.minVolume &&
                          change1h >= this.criteria.momentum.minChange1h &&
                          change6h >= this.criteria.momentum.minChange6h;
            
            if (passes) {
                analysis.categories.push({
                    type: 'momentum',
                    label: this.criteria.momentum.label,
                    score: (change1h || 0) * 3 + (change6h || 0) * 2 + (change24h || 0)
                });
            }
        }
        
        // Test Blue Chip
        if (token.chainId === 'solana' && age && age <= this.criteria.blueChip.maxAge) {
            const isPopular = this.criteria.blueChip.popularSymbols.includes(symbol.toUpperCase());
            const passes = (isPopular || liquidity >= this.criteria.blueChip.minLiquidity) &&
                          volume24h >= this.criteria.blueChip.minVolume &&
                          change24h >= this.criteria.blueChip.minChange24h;
            
            if (passes) {
                analysis.categories.push({
                    type: 'blueChip',
                    label: this.criteria.blueChip.label,
                    score: (change24h || 0) + (isPopular ? 50 : 0) + (liquidity / 100000)
                });
            }
        }
        
        // Score final = meilleur score parmi les catégories
        analysis.bestCategory = analysis.categories.length > 0 ? 
            analysis.categories.reduce((best, current) => 
                current.score > best.score ? current : best
            ) : null;
        
        analysis.passes = analysis.categories.length > 0;
        
        return analysis;
    }

    // Afficher l'analyse
    displayAnalysis(analysis) {
        const status = analysis.passes ? '✅ PASS' : '❌ SKIP';
        const categoryStr = analysis.bestCategory ? 
            `${analysis.bestCategory.label} (${analysis.bestCategory.score.toFixed(1)})` : 
            'Aucune catégorie';
        
        console.log(`\n${status} ${analysis.symbol} - ${categoryStr}`);
        console.log(`   📍 ${analysis.address.slice(0, 12)}...`);
        console.log(`   🏷️  ${analysis.name}`);
        console.log(`   📅 Âge: ${analysis.age}h`);
        console.log(`   💧 Liquidité: $${analysis.liquidity.toLocaleString()}`);
        console.log(`   📊 Volume 24h: $${analysis.volume24h.toLocaleString()}`);
        console.log(`   📈 Changes: 1h: ${analysis.change1h}% | 6h: ${analysis.change6h}% | 24h: ${analysis.change24h}%`);
        console.log(`   🎯 Source: ${analysis.source}`);
        
        if (analysis.categories.length > 1) {
            console.log(`   🏆 Multiples catégories: ${analysis.categories.map(c => c.label).join(', ')}`);
        }
    }

    // Scanner DexScreener pour Solana
    async scanDexScreener() {
        console.log('\n🔍 SCAN DEXSCREENER SOLANA');
        console.log('═'.repeat(50));
        
        const results = [];
        
        try {
            // Plusieurs endpoints pour maximiser les résultats
            const endpoints = [
                'https://api.dexscreener.com/latest/dex/search?q=SOL',
                'https://api.dexscreener.com/latest/dex/pairs/solana',
                'https://api.dexscreener.com/token-profiles/latest/v1'
            ];
            
            for (const endpoint of endpoints) {
                console.log(`\n🔗 Endpoint: ${endpoint}`);
                
                try {
                    const response = await fetch(endpoint);
                    
                    if (!response.ok) {
                        console.log(`❌ Erreur: ${response.status}`);
                        continue;
                    }
                    
                    const data = await response.json();
                    
                    // Traiter selon le type de réponse
                    if (endpoint.includes('token-profiles')) {
                        // Token profiles - récupérer les pairs
                        console.log(`📡 ${data.length} token profiles`);
                        
                        for (const profile of data.slice(0, 50)) {
                            if (!profile.tokenAddress) continue;
                            
                            try {
                                const pairResponse = await fetch(
                                    `https://api.dexscreener.com/latest/dex/tokens/${profile.tokenAddress}`
                                );
                                
                                if (pairResponse.ok) {
                                    const pairData = await pairResponse.json();
                                    
                                    if (pairData.pairs) {
                                        for (const pair of pairData.pairs) {
                                            if (pair.chainId === 'solana') {
                                                const analysis = this.analyzeToken(pair, 'PROFILES');
                                                results.push(analysis);
                                                
                                                if (analysis.passes) {
                                                    this.displayAnalysis(analysis);
                                                }
                                            }
                                        }
                                    }
                                }
                                
                                await new Promise(resolve => setTimeout(resolve, 200));
                            } catch (error) {
                                console.log(`   ⚠️ Erreur pair: ${error.message}`);
                            }
                        }
                    } else {
                        // Réponses avec pairs directes
                        const pairs = data.pairs || [];
                        console.log(`📡 ${pairs.length} pairs`);
                        
                        for (const pair of pairs.slice(0, 100)) {
                            if (pair.chainId === 'solana') {
                                const analysis = this.analyzeToken(pair, 'DIRECT');
                                results.push(analysis);
                                
                                if (analysis.passes) {
                                    this.displayAnalysis(analysis);
                                }
                            }
                        }
                    }
                    
                } catch (error) {
                    console.log(`❌ Erreur endpoint: ${error.message}`);
                }
                
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
        } catch (error) {
            console.error('❌ Erreur scan DexScreener:', error.message);
        }
        
        return results;
    }

    // Scanner spécifique pour tokens populaires
    async scanPopularTokens() {
        console.log('\n🔍 SCAN TOKENS POPULAIRES');
        console.log('═'.repeat(50));
        
        const results = [];
        const popularTokens = [
            'So11111111111111111111111111111111111111112', // SOL
            'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
            'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // WIF
            'DflHWsLnrLZuNKGgBH7KBCGvLbNYfHjLWfXGYdQqZY3r', // TRUMP
            'AGFEad2et2ZJif9jaGpdMixQqvW5i81aBdvKe7PHNfz3', // POPCAT
            'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump', // PNUT
            'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82', // BOME
        ];
        
        for (const tokenAddress of popularTokens) {
            try {
                console.log(`\n🔍 Analyse: ${tokenAddress.slice(0, 12)}...`);
                
                const response = await fetch(
                    `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`
                );
                
                if (response.ok) {
                    const data = await response.json();
                    
                    if (data.pairs) {
                        for (const pair of data.pairs) {
                            if (pair.chainId === 'solana') {
                                const analysis = this.analyzeToken(pair, 'POPULAR');
                                results.push(analysis);
                                this.displayAnalysis(analysis);
                            }
                        }
                    }
                }
                
                await new Promise(resolve => setTimeout(resolve, 500));
                
            } catch (error) {
                console.log(`❌ Erreur token ${tokenAddress}: ${error.message}`);
            }
        }
        
        return results;
    }

    // Analyser les résultats
    analyzeResults(allResults) {
        console.log('\n📊 ANALYSE GLOBALE');
        console.log('═'.repeat(50));
        
        const passing = allResults.filter(r => r.passes);
        const byCategory = {};
        
        passing.forEach(r => {
            const cat = r.bestCategory.type;
            if (!byCategory[cat]) byCategory[cat] = [];
            byCategory[cat].push(r);
        });
        
        console.log(`📈 Total analysés: ${allResults.length}`);
        console.log(`✅ Tokens valides: ${passing.length}`);
        
        console.log('\n🏆 Par catégorie:');
        Object.entries(byCategory).forEach(([category, tokens]) => {
            console.log(`   ${this.criteria[category]?.label || category}: ${tokens.length} tokens`);
            
            // Top 3 de chaque catégorie
            const top3 = tokens
                .sort((a, b) => b.bestCategory.score - a.bestCategory.score)
                .slice(0, 3);
            
            top3.forEach((token, i) => {
                console.log(`     ${i+1}. ${token.symbol} - ${token.bestCategory.score.toFixed(1)} pts - ${token.age}h`);
            });
        });
        
        // Recommandations finales
        console.log('\n🎯 RECOMMANDATIONS:');
        const topTokens = passing
            .sort((a, b) => b.bestCategory.score - a.bestCategory.score)
            .slice(0, 10);
        
        topTokens.forEach((token, i) => {
            console.log(`   ${i+1}. ${token.symbol} (${token.bestCategory.label}) - Score: ${token.bestCategory.score.toFixed(1)}`);
            console.log(`       📊 ${token.change1h}% 1h | ${token.change6h}% 6h | ${token.change24h}% 24h`);
            console.log(`       💧 $${token.liquidity.toLocaleString()} liq | $${token.volume24h.toLocaleString()} vol`);
        });
    }

    // Fonction principale
    async runScan() {
        console.log('🚀 SCANNER SOLANA FOCUS - DÉMARRAGE');
        console.log('═'.repeat(60));
        
        const allResults = [];
        
        // Scanner DexScreener
        const dexResults = await this.scanDexScreener();
        allResults.push(...dexResults);
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Scanner tokens populaires
        const popularResults = await this.scanPopularTokens();
        allResults.push(...popularResults);
        
        // Analyser les résultats
        this.analyzeResults(allResults);
        
        console.log('\n🎉 SCAN TERMINÉ');
        return allResults.filter(r => r.passes);
    }
}

// Fonction pour lancer le scan
async function runSolanaFocusedScan() {
    const scanner = new SolanaFocusedScanner();
    return await scanner.runScan();
}

// Exécution si lancé directement
if (require.main === module) {
    runSolanaFocusedScan().catch(error => {
        console.error('❌ Erreur scan:', error);
    });
}

module.exports = { SolanaFocusedScanner, runSolanaFocusedScan };