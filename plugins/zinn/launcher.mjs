try{await import(new URL("./server.mjs",import.meta.url).href)}catch(r){if(r.name!=="AbortError")process.stderr.write(`Zinn inspector setup: ${r.message}
`),process.exitCode=1}
