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

const app = express();

// 6. Definição de PORT
// 7. Definição de JWT_SECRET
const JWT_SECRET = process.env.JWT_SECRET;

// 2. Configuração de middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 3. Configuração de multer para upload de arquivos
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = 'uploads';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir);
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});

const upload = multer({ storage });

// 4. Inicialização Firebase com variáveis de ambiente
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_URL
    });
} catch (error) {
    console.error('Erro ao inicializar Firebase:', error);
    // Em um ambiente de produção, você pode querer sair do processo ou lidar com isso de forma mais robusta
    process.exit(1); 
}

const db = admin.database();

// 5. Configuração Nodemailer
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: false, // Use 'true' se o servidor de e-mail usar SSL/TLS (porta 465)
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    }
});

// 8. Credenciais admin
const ADMIN_EMAIL = 'diego.coelho@souenergy.com.br';
const ADMIN_PASSWORD_HASH = bcrypt.hashSync('teste123', 10); // Em produção, a senha deve vir de uma variável de ambiente ou ser mais segura

// ===== ROTAS DE AUTENTICAÇÃO =====

// 9. Rota POST /api/login com autenticação JWT
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (email !== ADMIN_EMAIL) {
            return res.status(401).json({ message: 'Email ou senha inválidos' });
        }
        
        const passwordMatch = bcrypt.compareSync(password, ADMIN_PASSWORD_HASH);
        if (!passwordMatch) {
            return res.status(401).json({ message: 'Email ou senha inválidos' });
        }
        
        const token = jwt.sign(
            { email, role: 'admin' },
            JWT_SECRET,
            { expiresIn: '7d' }
        );
        
        res.json({ 
            token,
            message: 'Login realizado com sucesso'
        });
    } catch (error) {
        console.error('Erro no login:', error);
        res.status(500).json({ message: 'Erro no servidor' });
    }
});

// 10. Middleware authenticate para proteger rotas
const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ message: 'Token não fornecido' });
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        res.status(401).json({ message: 'Token inválido' });
    }
};

// ===== ROTAS DE COTAÇÃO =====

// 11. Rota POST /api/cotacao com validação COMPLETA de todos os campos
app.post('/api/cotacao', upload.single('productPicture'), async (req, res) => {
    try {
        const {
            companyName,
            contactPerson,
            email,
            supplierModel,
            power,
            minTemp,
            maxTemp,
            qtyBaskets,
            basketVolume,
            removableBasket,
            viewWindow,
            fobPrice,
            fobCity,
            paymentTerms,
            deliveryTime,
            moq,
            cartonSize,
            qtyPerCarton,
            unitCbm,
            qty40hc
        } = req.body;
        
        // Validação completa de todos os campos
            return res.status(400).json({ message: 'Por favor, preencha todos os campos obrigatórios.' });
        }
        
        // Preparar dados da cotação
        const cotacao = {
            companyName,
            contactPerson,
            email,
            supplierModel,
            power: parseFloat(power),
            minTemp: parseFloat(minTemp),
            maxTemp: parseFloat(maxTemp),
            qtyBaskets: parseFloat(qtyBaskets),
            basketVolume: parseFloat(basketVolume),
            removableBasket: removableBasket === 'true', // Converte string para boolean
            viewWindow: viewWindow === 'true', // Converte string para boolean
            fobPrice: parseFloat(fobPrice),
            fobCity,
            paymentTerms,
            deliveryTime: parseInt(deliveryTime),
            moq: parseInt(moq),
            cartonSize,
            qtyPerCarton: parseInt(qtyPerCarton),
            unitCbm: parseFloat(unitCbm),
            qty40hc: parseInt(qty40hc),
            imagemFileName: req.file ? req.file.filename : null,
            imagemPath: req.file ? `/uploads/${req.file.filename}` : null,
            dataCriacao: new Date().toISOString(),
            status: 'recebida'
        };
        
        // Salvar no Firebase
        const novaRef = db.ref('cotacoes').push();
        await novaRef.set(cotacao);
        
        // Enviar email de notificação
        await enviarEmailNotificacao(cotacao);
        
        res.json({
            message: 'Cotação recebida com sucesso!',
            id: novaRef.key
        });
        
    } catch (error) {
        console.error('Erro ao processar cotação:', error);
        res.status(500).json({ message: 'Erro ao processar cotação' });
    }
});

// 12. Rota GET /api/cotacoes com autenticação
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
        
        // Ordenar por data (mais recentes primeiro)
        cotacoes.sort((a, b) => new Date(b.dataCriacao) - new Date(a.dataCriacao));
        
        res.json(cotacoes);
    } catch (error) {
        console.error('Erro ao listar cotações:', error);
        res.status(500).json({ message: 'Erro ao listar cotações' });
    }
});

// 13. Rota GET /api/cotacao/:id com autenticação
app.get('/api/cotacao/:id', authenticate, async (req, res) => {
    try {
        const snapshot = await db.ref(`cotacoes/${req.params.id}`).once('value');
        const cotacao = snapshot.val();
        
        if (!cotacao) {
            return res.status(404).json({ message: 'Cotação não encontrada' });
        }
        
        res.json({
            id: req.params.id,
            ...cotacao
        });
    } catch (error) {
        console.error('Erro ao obter cotação:', error);
        res.status(500).json({ message: 'Erro ao obter cotação' });
    }
});

// 16. Middleware para servir arquivos /uploads
app.use('/uploads', express.static('uploads'));

// 14. Rota GET /api/exportar-excel com autenticação
app.get('/api/exportar-excel', authenticate, async (req, res) => {
    try {
        const ExcelJS = require('exceljs'); // Importa aqui para garantir que só é carregado quando necessário
        const snapshot = await db.ref('cotacoes').once('value');
        const cotacoes = [];
        
        snapshot.forEach((child) => {
            cotacoes.push({
                id: child.key,
                ...child.val()
            });
        });
        
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Cotações');
        
        // Cabeçalhos
        worksheet.columns = [
            { header: 'ID', key: 'id', width: 15 },
            { header: 'Data', key: 'dataCriacao', width: 18 },
            { header: 'Empresa', key: 'companyName', width: 20 },
            { header: 'Contato', key: 'contactPerson', width: 15 },
            { header: 'Email', key: 'email', width: 20 },
            { header: 'Produto', key: 'supplierModel', width: 25 },
            { header: 'Potência (W)', key: 'power', width: 12 },
            { header: 'Temp Mín', key: 'minTemp', width: 10 },
            { header: 'Temp Máx', key: 'maxTemp', width: 10 },
            { header: 'Cestos', key: 'qtyBaskets', width: 10 },
            { header: 'Vol Cesto (L)', key: 'basketVolume', width: 12 },
            { header: 'Removível', key: 'removableBasket', width: 10 },
            { header: 'Janela', key: 'viewWindow', width: 10 },
            { header: 'FOB Price', key: 'fobPrice', width: 12 },
            { header: 'Cidade FOB', key: 'fobCity', width: 15 },
            { header: 'Pagamento', key: 'paymentTerms', width: 20 },
            { header: 'Lead Time (dias)', key: 'deliveryTime', width: 12 },
            { header: 'MOQ', key: 'moq', width: 10 },
            { header: 'Caixa (LxAxP)', key: 'cartonSize', width: 15 },
            { header: 'Qtd/Caixa', key: 'qtyPerCarton', width: 10 },
            { header: 'CBM', key: 'unitCbm', width: 10 },
            { header: 'Qtd 40HC', key: 'qty40hc', width: 10 }
        ];
        
        cotacoes.forEach(cot => {
            worksheet.addRow(cot);
        });
        
        // Formatar cabeçalho
        worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF667eea' } };
        
        // Gerar arquivo
        const filename = `cotacoes_${Date.now()}.xlsx`;
        // Salva o arquivo temporariamente no sistema de arquivos do Vercel
        await workbook.xlsx.writeFile(filename); 
        
        res.download(filename, () => {
            // Remove o arquivo após o download
            fs.unlinkSync(filename); 
        });
        
    } catch (error) {
        console.error('Erro ao exportar para Excel:', error);
        res.status(500).json({ message: 'Erro ao exportar para Excel' });
    }
});

// ===== FUNÇÃO AUXILIAR =====

// 15. Função enviarEmailNotificacao com template HTML
async function enviarEmailNotificacao(cotacao) {
    try {
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: ADMIN_EMAIL,
            subject: `🆕 Nova Cotação Recebida - ${cotacao.supplierModel}`,
            html: `
                <h2>Nova Cotação Recebida!</h2>
                <hr>
                <h3>📋 Informações do Fornecedor</h3>
                <p><strong>Empresa:</strong> ${cotacao.companyName}</p>
                <p><strong>Contato:</strong> ${cotacao.contactPerson}</p>
                <p><strong>Email:</strong> ${cotacao.email}</p>
                
                <h3>📦 Produto</h3>
                <p><strong>Modelo:</strong> ${cotacao.supplierModel}</p>
                
                <h3>💰 Preço e Logística</h3>
                <p><strong>FOB Price:</strong> $${cotacao.fobPrice.toFixed(2)}</p>
                <p><strong>Cidade FOB:</strong> ${cotacao.fobCity}</p>
                <p><strong>Lead Time:</strong> ${cotacao.deliveryTime} dias</p>
                <p><strong>MOQ:</strong> ${cotacao.moq} unidades</p>
                
                <hr>
                <p>Acesse seu painel admin para ver todos os detalhes da cotação.</p>
            `
        };
        
        await transporter.sendMail(mailOptions);
        console.log('Email de notificação enviado com sucesso');
    } catch (error) {
        console.error('Erro ao enviar email de notificação:', error);
    }
}

// 17. Inicialização do servidor ao final
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
