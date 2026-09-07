const fs = require('fs');
let c = fs.readFileSync('src/services/pdfService.ts', 'utf8');
c = c.split('\\`').join('`');
c = c.split('\\$').join('$');
fs.writeFileSync('src/services/pdfService.ts', c);
