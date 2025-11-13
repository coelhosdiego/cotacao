// ARQUIVO: server.js - VERSÃO DEFINITIVA E VERIFICADA

// ===== 1. IMPORTAÇÕES E CONFIGURAÇÃO INICIAL =====
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

// ===== 2. VARIÁVEIS DE AMBIENTE E CONSTANTES =====
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_EMAIL = 'diego.coelho@souenergy.com.br';
const ADMIN_PASSWORD_HASH = bcrypt.hashSync('teste123', 10); // Senha 'teste123'

const app = express();

// ===== 3. MIDDLEWARE GERAL =====
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== 4. CONFIGURAÇÃO DE ARQUIVOS (UPLOAD) PARA VERCEL =====
const uploadDir = path.join('/tmp', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${path.extname(file.originalname)}`)
});
const upload = multer({ storage });

// ===== 5. INICIALIZAÇÃO DE SERVIÇOS EXTERNOS =====
// Firebase
try {
    if (admin.apps.length === 0) { // Evita reinicialização
        const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: process.env.FIREBASE_URL
        });
    }
} catch (error) {
    console.error("ERRO CRÍTICO: Falha ao inicializar o Firebase. Verifique a variável 'FIREBASE_CONFIG'.", error);
}
const db = admin.database();

// Nodemailer
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT, 10),
    secure: parseInt(process.env.EMAIL_PORT, 10) === 465,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD }
});

// ===== 6. ROTAS DA APLICAÇÃO =====

// --- Rota de Login ---
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
            return res.status(401).json({ message: 'Credenciais inválidas.' });
        }
        const token = jwt.sign({ email, role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
        res.status(200).json({ token, message: 'Login bem-sucedido.' });
    } catch (error) {
        console.error('Erro na rota de login:', error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
});

// --- Middleware de Autenticação ---
const authenticate = (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ message: 'Acesso negado. Token não fornecido.' });
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (error) {
        return res.status(401).json({ message: 'Acesso negado. Token inválido ou expirado.' });
    }
};

// --- Rota para Envio de Cotação ---
app.post('/api/cotacao', upload.single('productPicture'), async (req, res) => {
    try {
        const { companyName, contactPerson, email, supplierModel, power, minTemp, maxTemp, qtyBaskets, basketVolume, removableBasket, viewWindow, fobPrice, fobCity, paymentTerms, deliveryTime, moq, cartonSize, qtyPerCarton, unitCbm, qty40hc } = req.body;

        // VALIDAÇÃO DEFINITIVA.
            return res.status(400).json({ message: 'Todos os campos do formulário são obrigatórios.' });
        }

        const cotacao = {
            companyName, contactPerson, email, supplierModel, removableBasket, viewWindow, fobCity, paymentTerms, cartonSize,
            power: parseFloat(power), minTemp: parseFloat(minTemp), maxTemp: parseFloat(maxTemp),
            qtyBaskets: parseInt(qtyBaskets, 10), basketVolume: parseFloat(basketVolume),
            fobPrice: parseFloat(fobPrice), deliveryTime: parseInt(deliveryTime, 10), moq: parseInt(moq, 10),
            qtyPerCarton: parseInt(qtyPerCarton, 10), unitCbm: parseFloat(unitCbm), qty40hc: parseInt(qty40hc, 10),
            imagemFileName: req.file ? req.file.filename : null,
            dataCriacao: new Date().toISOString(), status: 'recebida'
        };

        const novaRef = db.ref('cotacoes').push();
        await novaRef.set(cotacao);
        await enviarEmailNotificacao(cotacao);

        res.status(201).json({ message: 'Cotação enviada com sucesso!', id: novaRef.key });
    } catch (error) {
        console.error('Erro ao processar cotação:', error);
        res.status(500).json({ message: 'Erro interno ao processar a cotação.' });
    }
});

// --- Rota para Listar Cotações (Protegida) ---
app.get('/api/cotacoes', authenticate, async (req, res) => {
    try {
        const snapshot = await db.ref('cotacoes').once('value');
        const cotacoesObj = snapshot.val();
        if (!cotacoesObj) return res.status(200).json([]);
        
        const cotacoes = Object.keys(cotacoesObj)
            .map(key => ({ id: key, ...cotacoesObj[key] }))
            .sort((a, b) => new Date(b.dataCriacao) - new Date(a.dataCriacao));
        
        res.status(200).json(cotacoes);
    } catch (error) {
        console.error('Erro ao listar cotações:', error);
        res.status(500).json({ message: 'Erro ao obter dados.' });
    }
});

// --- Rota para Servir Imagens do /tmp ---
app.get('/api/images/:filename', (req, res) => {
    const filePath = path.join(uploadDir, req.params.filename);
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).json({ message: 'Imagem não encontrada.' });
    }
});

// --- Rota para Exportar Excel (Protegida) ---
app.get('/api/exportar-excel', authenticate, async (req, res) => {
    try {
        const ExcelJS = require('exceljs');
        const snapshot = await db.ref('cotacoes').once('value');
        const cotacoesObj = snapshot.val();
        if (!cotacoesObj) return res.status(404).json({ message: 'Nenhuma cotação encontrada para exportar.' });

        const cotacoes = Object.keys(cotacoesObj).map(key => ({ id: key, ...cotacoesObj[key] }));

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Cotações');
        worksheet.columns = [
            { header: 'ID', key: 'id', width: 30 }, { header: 'Data', key: 'dataCriacao', width: 20 },
            { header: 'Empresa', key: 'companyName', width: 25 }, { header: 'Contato', key: 'contactPerson', width: 20 },
            { header: 'Email', key: 'email', width: 30 }, { header: 'Modelo Fornecedor', key: 'supplierModel', width: 20 },
            { header: 'Preço FOB', key: 'fobPrice', width: 15, style: { numFmt: '"$"#,##0.00' } },
            { header: 'MOQ', key: 'moq', width: 10 }, { header: 'Cidade FOB', key: 'fobCity', width: 15 },
        ];
        worksheet.getRow(1).font = { bold: true };
        worksheet.addRows(cotacoes);

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="cotacoes_${new Date().toISOString().split('T')[0]}.xlsx"`);

        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('Erro ao exportar para Excel:', error);
        res.status(500).json({ message: 'Erro ao gerar o arquivo Excel.' });
    }
});

// ===== 7. FUNÇÃO AUXILIAR =====
async function enviarEmailNotificacao(cotacao) {
    const { companyName, contactPerson, supplierModel } = cotacao;
    try {
        await transporter.sendMail({
            from: `"Painel Sou Energy" <${process.env.EMAIL_USER}>`,
            to: ADMIN_EMAIL,
            subject: `Nova Cotação de ${companyName} para ${supplierModel}`,
            html: `<h1>Nova Cotação Recebida</h1><p><b>Empresa:</b> ${companyName}</p><p><b>Contato:</b> ${contactPerson}</p><p><b>Modelo:</b> ${supplierModel}</p><hr><p>Acesse o painel administrativo para visualizar todos os detalhes.</p>`
        });
        console.log(`Email de notificação para a cotação de ${companyName} enviado com sucesso.`);
    } catch (error) {
        console.error(`Falha ao enviar email de notificação para ${companyName}:`, error);
    }
}

// ===== 8. INICIALIZAÇÃO DO SERVIDOR E EXPORTAÇÃO PARA VERCEL =====
app.listen(PORT, () => {
    console.log(`Servidor local rodando na porta ${PORT}.`);
});

module.exports = app;
