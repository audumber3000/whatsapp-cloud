const jwt = require('jsonwebtoken');

const JWT_SECRET = 'super-secret-wa-reach-key-123';
const token = jwt.sign({ username: 'admin', id: 1 }, JWT_SECRET);

fetch('http://localhost:3000/api/wa/status', {
    headers: { 'Authorization': `Bearer ${token}` }
})
.then(res => res.json())
.then(data => {
    console.log(data);
    process.exit(0);
})
.catch(err => {
    console.error(err);
    process.exit(1);
});
