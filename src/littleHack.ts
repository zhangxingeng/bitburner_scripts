// import { NS } from "@ns";

// async function little_hack(ns, hack_target, weaken_threads, grow_threads, hack_threads, reserved_RAM) {
//     const host_servers = await initializeServers(ns);
//     const usable_RAM = calculateUsableRAM(ns, host_servers, reserved_RAM);

//     let sec_increase;
//     const startTime = Date.now();
//     let c = 2;

//     while (!hasEnoughRAM(ns, grow_threads, hack_threads, weaken_threads, usable_RAM, host_servers.length)) {
//         c += 1;
//         [grow_threads, hack_threads, sec_increase] = calculateThreadRequirements(ns, hack_target, c);
//         weaken_threads = calculateWeakenThreads(ns, sec_increase);

//         if (Date.now() > startTime + 240000) {
//             throw new Error("Loop exceeded 2 minutes. Consider increasing RAM or adjusting 'c'");
//         }
//     }

//     if (hack_threads < 1 || weaken_threads < 1 || grow_threads < 1) {
//         ns.print(hack_threads, weaken_threads, grow_threads);
//         return 0;
//     }

//     for (const server of host_servers) {
//         await deployScripts(ns, server, reserved_RAM, hack_target, weaken_threads, grow_threads, hack_threads);
//     }
// }

// async function initializeServers(ns) {
//     const full_list = ns.scan('home');
//     const host_servers = [];

//     for (const server of full_list) {
//         if (ns.hasRootAccess(server)) {
//             const scripts = ['targeted-hack.js', 'targeted-grow.js', 'targeted-weaken.js'];
//             for (const script of scripts) {
//                 await ns.scp(script, 'home', server);
//             }
//             host_servers.push(server);
//         }
//     }
//     return host_servers;
// }

// function calculateUsableRAM(ns, host_servers, reserved_RAM) {
//     return host_servers.reduce((total, server) => {
//         if (server === 'home') {
//             return total + ns.getServerMaxRam(server) - ns.getServerUsedRam(server) - reserved_RAM;
//         }
//         return total + ns.getServerMaxRam(server) - ns.getServerUsedRam(server);
//     }, 0);
// }

// function hasEnoughRAM(ns, grow_threads, hack_threads, weaken_threads, usable_RAM, hostCount) {
//     return grow_threads * ns.getScriptRam('targeted-grow.js', 'home') + hack_threads * ns.getScriptRam('targeted-hack.js', 'home') + weaken_threads * ns.getScriptRam('targeted-weaken.js', 'home') <= usable_RAM - hostCount;
// }

// function calculateThreadRequirements(ns, hack_target, c) {
//     const grow_threads = Math.floor(ns.growthAnalyze(hack_target, 1 / (1 - 1 / c)));
//     const hack_threads = Math.floor(ns.hackAnalyzeThreads(hack_target, ns.getServerMoneyAvailable(hack_target) / c)) / ns.hackAnalyzeChance(hack_target);
//     const sec_increase = ns.hackAnalyzeSecurity(hack_threads) + ns.growthAnalyzeSecurity(grow_threads);
//     return [grow_threads, hack_threads, sec_increase];
// }

// function calculateWeakenThreads(ns, sec_increase) {
//     let weaken_threads = 1;
//     while (ns.weakenAnalyze(weaken_threads) < sec_increase * 1.1) {
//         weaken_threads += 3;
//     }
//     return weaken_threads;
// }

// async function deployScripts(ns, server, reserved_RAM, hack_target, weaken_threads, grow_threads, hack_threads) {
//     const scriptMapping = {
//         'targeted-weaken.js': weaken_threads,
//         'targeted-grow.js': grow_threads,
//         'targeted-hack.js': hack_threads
//     };
//     for (const [script, threads] of Object.entries(scriptMapping)) {
//         while (threads > 0 && ns.getServerMaxRam(server) - ns.getServerUsedRam(server) > ns.getScriptRam(script, 'home')) {
//             const availableRAM = server === 'home' ? ns.getServerMaxRam(server) - ns.getServerUsedRam(server) - reserved_RAM : ns.getServerMaxRam(server) - ns.getServerUsedRam(server);
//             const threadCount = Math.min(threads, Math.floor(availableRAM / ns.getScriptRam(script, 'home')));
//             if (threadCount >= 1) {
//                 ns.exec(script, server, threadCount, threadCount, hack_target);
//                 threads -= threadCount;
//                 await ns.sleep(5);
//             }
//         }
//     }
// }

