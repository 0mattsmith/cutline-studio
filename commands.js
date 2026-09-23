let dialog;
let currentEvent;

Office.onReady(() => {
    // If needed, we can log initialization here
});

function openDialog(event) {
    currentEvent = event;
    const url = new URL('index.html?dialog=true', window.location.href).href;
    
    // Open a dialog at 90% screen width and 90% screen height
    Office.context.ui.displayDialogAsync(url, { width: 90, height: 90, displayInIframe: true }, function (asyncResult) {
        if (asyncResult.status === Office.AsyncResultStatus.Failed) {
            console.error(asyncResult.error.message);
            event.completed();
        } else {
            dialog = asyncResult.value;
            dialog.addEventHandler(Office.EventType.DialogMessageReceived, processMessage);
            dialog.addEventHandler(Office.EventType.DialogEventReceived, () => event.completed());
        }
    });
}

async function processMessage(arg) {
    const message = arg.message;
    if (message.startsWith("READY:")) {
        const parts = message.split(":");
        const id = parts[1];
        const rawFooter = parts.slice(2).join(":");
        const footerText = rawFooter ? decodeURIComponent(rawFooter) : null;
        
        try {
            const base64 = await getBase64FromIndexedDB(id);
            
            await Word.run(async (context) => {
                const body = context.document.body;
                body.load("text");
                await context.sync();
                
                if (body.text.trim() === "") {
                    body.insertFileFromBase64(base64, Word.InsertLocation.replace);
                } else {
                    body.insertBreak(Word.BreakType.page, Word.InsertLocation.end);
                    body.insertFileFromBase64(base64, Word.InsertLocation.end);
                }
                
                if (footerText) {
                    const sections = context.document.sections;
                    sections.load("items");
                    await context.sync();
                    if (sections.items.length > 0) {
                        const section = sections.items[sections.items.length - 1];
                        const footer = section.getFooter(Word.HeaderFooterType.primary);
                        const p = footer.insertParagraph(footerText, Word.InsertLocation.end);
                        p.alignment = Word.Alignment.centered;
                        p.font.color = "#777777";
                        p.font.size = 10;
                    }
                }
                
                await context.sync();
            });
            
        } catch (e) {
            console.error("Failed to insert document from dialog:", e);
        } finally {
            if (dialog) {
                dialog.close();
            }
            if (currentEvent) {
                currentEvent.completed();
            }
        }
    }
}

function getBase64FromIndexedDB(id) {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open("CutlineStudioExchange", 1);
        
        // Just in case it hasn't been created, though the dialog should have created it
        req.onupgradeneeded = () => req.result.createObjectStore("files");
        
        req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction("files", "readonly");
            const getReq = tx.objectStore("files").get(id);
            
            getReq.onsuccess = () => {
                if (getReq.result) {
                    resolve(getReq.result);
                } else {
                    reject(new Error("File not found in IndexedDB"));
                }
                
                // Cleanup the DB record so it doesn't leak memory
                const delTx = db.transaction("files", "readwrite");
                delTx.objectStore("files").delete(id);
            };
            getReq.onerror = () => reject(getReq.error);
        };
        req.onerror = () => reject(req.error);
    });
}

// Register the function with Office
Office.actions.associate("openDialog", openDialog);
