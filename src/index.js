const express = require('express');
const app = express();
const port = 3000;

app.get('/', (req, res) => {
    res.status(200).json({message: 'Привіт, Світ!'})
})

app.listen(port, () => {
  console.log(`Сервер успішно запущено на http://localhost:${port}`);
});