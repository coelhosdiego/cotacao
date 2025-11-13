const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs'); // CORREÇÃO: Importar ExcelJS no topo
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuração de upload
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = 'uploads';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir);
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // CORREÇÃO: path.extname para manter a extensão original de forma segura
        const ext = path.extname(file.originalname); 
        cb(null, `${Date.now()}-${path.basename(file.originalname, ext)}${ext}`);
    }
});

const upload = multer({ storage });

// Inicializar Firebase
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_URL
    });
} catch (e) {
    console.error("Erro ao inicializar Firebase. Verifique FIREBASE_CONFIG e FIREBASE_URL no .env", e);
    // É crucial que a inicialização do Firebase funcione.
}

const db = admin.database();

// Configurar Nodemailer
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: process.env.EMAIL_PORT == 465, // Use 'secure: true' para porta 465, 'secure: false' para outras portas (ex: 587)
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    }
});

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET;

// Credenciais de admin
const ADMIN_EMAIL = 'diego.coelho@souenergy.com.br';
// CORREÇÃO: Pegar hash de variável de ambiente (gerada previamente)
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH; 

// ===== ROTAS DE AUTENTICAÇÃO =====

// Login
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (email !== ADMIN_EMAIL) {
            // Use uma mensagem genérica para não dar dicas sobre qual dado está errado
            return res.status(401).json({ message: 'Email ou senha inválidos' }); 
        }
        
        // CORREÇÃO: Verifique se o hash existe antes de comparar
        if (!ADMIN_PASSWORD_HASH) {
            console.error("ADMIN_PASSWORD_HASH não está definido no .env!");
            return res.status(500).json({ message: 'Erro de configuração no servidor' });
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
        console.error('Erro login:', error);
        res.status(500).json({ message: 'Erro no servidor' });
    }
});

// Middleware de autenticação
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

// Enviar cotação (formulário)
app.post('/api/cotacao', upload.single('productPicture'), async (req, res) => {
    try {
        const {
            companyName, contactPerson, email, supplierModel, power, minTemp, maxTemp, 
            qtyBaskets, basketVolume, removableBasket, viewWindow, fobPrice, fobCity, 
            paymentTerms, deliveryTime, moq, cartonSize, qtyPerCarton, unitCbm, qty40hc
        } = req.body;
        
        // CORREÇÃO: Validação de campos obrigatórios
        // Lista de campos que não podem ser vazios (ajuste conforme a necessidade)
        const requiredFields = [
            companyName, contactPerson, email, supplierModel, power, fobPrice, paymentTerms, 
            deliveryTime, moq
        ];

        if (requiredFields.some(field => !field)) {
            return res.status(400).json({ message: 'Please fill all required fields' });
        }
        
        // Preparar dados da cotação
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
            fobCity,
            paymentTerms,
            deliveryTime: parseInt(deliveryTime) || null,
            moq: parseInt(moq) || null,
            cartonSize,
            qtyPerCarton: parseInt(qtyPerCarton) || null,
            unitCbm: parseFloat(unitCbm) || null,
            qty40hc: parseInt(qty40hc) || null,
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
        // Se houver arquivo, considere removê-lo em caso de erro no DB.
        if (req.file) {
            fs.unlink(req.file.path, (err) => {
                if (err) console.error("Erro ao deletar arquivo de upload após falha no DB:", err);
            });
        }
        res.status(500).json({ message: 'Erro ao processar cotação' });
    }
});

// Listar todas as cotações (autenticado)
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

// Obter uma cotação específica (autenticado)
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
        console.error('Erro:', error);
        res.status(500).json({ message: 'Erro ao obter cotação' });
    }
});

// Servir imagens (público)
app.use('/uploads', express.static('uploads'));

// Exportar para Excel (autenticado)
app.get('/api/exportar-excel', authenticate, async (req, res) => {
    try {
        // ExcelJS já foi importado no topo
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
        
        // Cabeçalhos (o seu já estava correto)
        // ... (Seu código de cabeçalhos) ...
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
        await workbook.xlsx.writeFile(filename);
        
        res.download(filename, () => {
            fs.unlinkSync(filename);
        });
        
    } catch (error) {
        console.error('Erro ao exportar:', error);
        res.status(500).json({ message: 'Erro ao exportar' });
    }
});

// ===== FUNÇÃO AUXILIAR (Email) =====

async function enviarEmailNotificacao(cotacao) {
    // ... (Sua função enviarEmailNotificacao não tinha erros críticos) ...
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
                <p><strong>FOB Price:</strong> $${(cotacao.fobPrice || 0).toFixed(2)}</p>
                <p><strong>Cidade FOB:</strong> ${cotacao.fobCity}</p>
                <p><strong>Lead Time:</strong> ${cotacao.deliveryTime} dias</p>
                <p><strong>MOQ:</strong> ${cotacao.moq} unidades</p>
                
                <hr>
                ${cotacao.imagemPath ? `<p><strong>Imagem:</strong> <a href="${process.env.BASE_URL}${cotacao.imagemPath}">Visualizar Imagem</a></p>` : ''}
                <p>Acesse seu painel admin para ver todos os detalhes da cotação.</p>
            `
        };
        
        await transporter.sendMail(mailOptions);
        console.log('Email enviado com sucesso');
    } catch (error) {
        console.error('Erro ao enviar email:', error);
    }
}

// ===== INICIAR SERVIDOR =====

// CORREÇÃO: Defina a variável PORT
const PORT = process.env.PORT || 3000; 

app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
