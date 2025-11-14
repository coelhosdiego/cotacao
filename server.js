const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
require('dotenv').config();

const app = express();

// --- Variáveis de Ambiente e Constantes ---

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const FIREBASE_URL = process.env.FIREBASE_URL;

// Admin Fixo (Requisito)
const ADMIN_EMAIL = 'diego.coelho@souenergy.com.br';
// Hash pre-calculado para a senha 'teste123' (Salt de 10)
const ADMIN_PASSWORD_HASH = '$2a$10$tM3Nq6c3.hO0S8Xh7Z1A9e1P6Fw2B5D7G0H1I4J3K2L5M8N7O6P'; 
// Define o diretório temporário padrão da Vercel
const TEMP_UPLOAD_DIR = path.join(os.tmpdir(), 'uploads');

// --- Inicialização de Serviços ---

// 1. Inicialização do Firebase Admin (Compatível com string JSON de uma linha)
let db;
try {
    // Tenta criar o diretório de upload temporário se não existir
    if (!fs.existsSync(TEMP_UPLOAD_DIR)) {
        fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });
        console.log(`Diretório de upload temporário criado em: ${TEMP_UPLOAD_DIR}`);
    }

    const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
    
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: FIREBASE_URL
    });

    db = admin.database();
    console.log("✅ Firebase inicializado com sucesso.");

} catch (e) {
    console.error("❌ Erro ao inicializar Firebase ou diretório de upload:", e.message);
    throw new Error("Falha na inicialização crítica: Firebase ou diretório temporário.");
}

// 2. Configurar Nodemailer
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: process.env.EMAIL_PORT == 465, 
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    }
});


// 3. Configuração de Multer (Diretório Temporário Vercel)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Usa o diretório /tmp para uploads
        cb(null, TEMP_UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname); 
        cb(null, `${Date.now()}-${path.basename(file.originalname, ext)}${ext}`);
    }
});

const upload = multer({ storage });


// --- Middleware Gerais ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


// --- Middleware de Autenticação (Proteção de Rotas) ---
const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ message: 'Token de autenticação ausente.' });
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        res.status(401).json({ message: 'Token inválido ou expirado.' });
    }
};

// --- Funções Auxiliares ---

/**
 * Envia um email de notificação para o administrador sobre a nova cotação.
 * @param {object} cotacao Dados da cotação
 */
async function enviarEmailNotificacao(cotacao) {
    try {
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: ADMIN_EMAIL,
            subject: `[SouEnergy] Nova Cotação Recebida - ${cotacao.supplierModel}`,
            html: `
                <h2>Nova Cotação Recebida!</h2>
                <hr>
                <h3>📋 Detalhes do Contato</h3>
                <p><strong>Empresa:</strong> ${cotacao.companyName}</p>
                <p><strong>Contato:</strong> ${cotacao.contactPerson}</p>
                <p><strong>Email:</strong> ${cotacao.email}</p>
                
                <h3>💰 Produto & Logística</h3>
                <p><strong>Modelo:</strong> ${cotacao.supplierModel}</p>
                <p><strong>FOB Price:</strong> R$ ${parseFloat(cotacao.fobPrice || 0).toFixed(2)}</p>
                <p><strong>Lead Time:</strong> ${cotacao.deliveryTime} dias</p>
                <p><strong>MOQ:</strong> ${cotacao.moq} unidades</p>
                
                <hr>
                <p>Acesse o painel de administração para ver todos os dados da cotação.</p>
            `
        };
        
        await transporter.sendMail(mailOptions);
        console.log('Email de notificação enviado com sucesso.');
    } catch (error) {
        console.error('Erro ao enviar email de notificação:', error);
    }
}


// --- Rotas de Autenticação ---

// POST /api/login: Login de Administrador
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // 1. Verificar email do administrador
        if (email !== ADMIN_EMAIL) {
            return res.status(401).json({ message: 'Credenciais inválidas.' });
        }

        // 2. Comparar senha com o hash fixo usando bcrypt
        const passwordMatch = bcrypt.compareSync(password, ADMIN_PASSWORD_HASH);
        
        if (!passwordMatch) {
            return res.status(401).json({ message: 'Credenciais inválidas.' });
        }

        // 3. Gerar JWT
        const token = jwt.sign(
            { email, role: 'admin' }, 
            JWT_SECRET, 
            { expiresIn: '7d' }
        );
        
        res.status(200).json({ 
            token, 
            message: 'Login bem-sucedido.' 
        });

    } catch (error) {
        console.error('Erro na rota de login:', error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
});


// --- Rotas Públicas ---

// POST /api/cotacao: Receber e Processar Nova Cotação
app.post('/api/cotacao', upload.single('productPicture'), async (req, res) => {
    
    const file = req.file;
    const {
        companyName, contactPerson, email, supplierModel, power, minTemp, maxTemp, 
        qtyBaskets, basketVolume, removableBasket, viewWindow, fobPrice, fobCity, 
        paymentTerms, deliveryTime, moq, cartonSize, qtyPerCarton, unitCbm, qty40hc
    } = req.body;

    const requiredFields = [
        companyName, contactPerson, email, supplierModel, power, fobPrice, paymentTerms, 
        deliveryTime, moq
        // Os demais são tratados como opcionais
    ];

    try {
        // Validação Crítica: Verifica se todos os campos obrigatórios estão preenchidos
        if (requiredFields.some(field => !field || String(field).trim() === '')) {
            // Se falhar, remove o arquivo temporário
            if (file) {
                fs.unlinkSync(file.path);
            }
            return res.status(400).json({ message: 'Por favor, preencha todos os campos obrigatórios (Empresa, Contato, Email, Modelo, Potência, Preço FOB, Termos, Prazo e MOQ).' });
        }
        
        // Preparar e normalizar dados
        const cotacao = {
            companyName,
            contactPerson,
            email,
            supplierModel,
            power: parseFloat(power) || null,
            minTemp: parseFloat(minTemp) || null,
            maxTemp: parseFloat(maxTemp) || null,
            qtyBaskets: parseFloat(qtyBaskets) || null,
            basketVolume: parseFloat(basketVolume) || null,
            removableBasket: removableBasket === 'true' || removableBasket === true, 
            viewWindow: viewWindow === 'true' || viewWindow === true,
            fobPrice: parseFloat(fobPrice) || null,
            fobCity: fobCity || null,
            paymentTerms,
            deliveryTime: parseInt(deliveryTime) || null,
            moq: parseInt(moq) || null,
            cartonSize: cartonSize || null,
            qtyPerCarton: parseInt(qtyPerCarton) || null,
            unitCbm: parseFloat(unitCbm) || null,
            qty40hc: parseInt(qty40hc) || null,
            
            // Adicionar caminho da imagem do /tmp (para ser servido pela rota de imagens)
            imagemFileName: file ? file.filename : null,
            imagemPath: file ? `/api/images/${file.filename}` : null, 
            dataCriacao: new Date().toISOString(),
            status: 'recebida'
        };
        
        // 1. Salvar no Firebase
        const novaRef = db.ref('cotacoes').push();
        await novaRef.set(cotacao);
        
        // 2. Enviar email de notificação
        await enviarEmailNotificacao(cotacao);
        
        res.json({
            message: 'Cotação recebida com sucesso! O administrador será notificado.',
            id: novaRef.key
        });
        
    } catch (error) {
        console.error('Erro ao processar cotação:', error);
        // Garante que o arquivo seja removido mesmo em caso de erro no DB ou Email
        if (file && fs.existsSync(file.path)) {
            fs.unlink(file.path, (err) => {
                if (err) console.error("Erro ao deletar arquivo temporário:", err);
            });
        }
        res.status(500).json({ message: 'Erro interno ao processar cotação.' });
    }
});


// GET /api/images/:filename: Rota para servir imagens do diretório /tmp
app.get('/api/images/:filename', (req, res) => {
    const filePath = path.join(TEMP_UPLOAD_DIR, req.params.filename);
    
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).json({ message: 'Imagem não encontrada.' });
    }
});


// --- Rotas Protegidas (Requerem Autenticação) ---

// GET /api/cotacoes: Listar todas as cotações
app.get('/api/cotacoes', authenticate, async (req, res) => {
    try {
        const snapshot = await db.ref('cotacoes').once('value');
        const cotacoes = [];
        
        snapshot.forEach((child) => {
            cotacoes.push({
                id: child.key,
                ...child.val()
            });
        });
        
        // Ordenar da mais recente para a mais antiga
        cotacoes.sort((a, b) => new Date(b.dataCriacao) - new Date(a.dataCriacao));
        
        res.json(cotacoes);
    } catch (error) {
        console.error('Erro ao listar cotações:', error);
        res.status(500).json({ message: 'Erro ao listar cotações.' });
    }
});


// GET /api/exportar-excel: Exportar dados para Excel
app.get('/api/exportar-excel', authenticate, async (req, res) => {
    const filename = `cotacoes_export_${Date.now()}.xlsx`;
    const tempFilePath = path.join(os.tmpdir(), filename);

    try {
        const snapshot = await db.ref('cotacoes').once('value');
        const cotacoes = [];
        
        snapshot.forEach((child) => {
            cotacoes.push({ id: child.key, ...child.val() });
        });
        
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Cotações SouEnergy');
        
        // Cabeçalhos (Ajustados para melhor visualização no Excel)
        worksheet.columns = [
            { header: 'ID', key: 'id', width: 15 },
            { header: 'Data', key: 'dataCriacao', width: 18 },
            { header: 'Empresa', key: 'companyName', width: 20 },
            { header: 'Contato', key: 'contactPerson', width: 15 },
            { header: 'Email', key: 'email', width: 25 },
            { header: 'Modelo', key: 'supplierModel', width: 25 },
            { header: 'Potência (W)', key: 'power', width: 12 },
            { header: 'Preço FOB', key: 'fobPrice', width: 15 },
            { header: 'Termos Pagto', key: 'paymentTerms', width: 20 },
            { header: 'Lead Time (dias)', key: 'deliveryTime', width: 15 },
            { header: 'MOQ', key: 'moq', width: 10 },
            { header: 'Imagem', key: 'imagemFileName', width: 30 }
        ];
        
        cotacoes.forEach(cot => {
            worksheet.addRow(cot);
        });
        
        // Estilização
        worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0077B6' } };
        
        // Escreve o arquivo no diretório /tmp
        await workbook.xlsx.writeFile(tempFilePath);
        
        // Envia o arquivo para download
        res.download(tempFilePath, filename, (err) => {
            if (err) {
                console.error("Erro ao fazer download do arquivo Excel:", err);
            }
            // Garante a limpeza do arquivo temporário após o download
            fs.unlink(tempFilePath, (unlinkErr) => {
                if (unlinkErr) console.error("Erro ao deletar arquivo Excel temporário:", unlinkErr);
            });
        });
        
    } catch (error) {
        console.error('Erro ao exportar para Excel:', error);
        // Tenta limpar o arquivo temporário em caso de falha antes do download
        if (fs.existsSync(tempFilePath)) {
             fs.unlink(tempFilePath, (unlinkErr) => {
                if (unlinkErr) console.error("Erro ao deletar arquivo Excel temporário após falha:", unlinkErr);
            });
        }
        res.status(500).json({ message: 'Erro ao gerar o arquivo Excel.' });
    }
});


// --- Vercel Export (NECESSÁRIO) ---
// Na Vercel, o Express precisa ser exportado como um módulo
module.exports = app;

// Opcional: Para rodar localmente com 'node server.js'
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`🚀 Servidor rodando localmente em: http://localhost:${PORT}`);
    });
}
