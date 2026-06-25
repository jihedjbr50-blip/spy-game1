const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

const rooms = {};

io.on('connection', (socket) => {

    // انضمام لاعب أو إنشاء غرفة
    socket.on('joinRoom', ({ username, roomName }) => {
        socket.join(roomName);
        socket.roomName = roomName;
        socket.username = username;

        if (!rooms[roomName]) {
            rooms[roomName] = {
                players: [],
                gameStarted: false,
                spy: null,
                word: '',
                votes: {},
                notes: {},
                isVoting: false,
                startRequests: [] // مصفوفة مضمونة لتخزين الـ IDs الموافقة
            };
        }

        const room = rooms[roomName];

        if (room.gameStarted) {
            socket.emit('errorMsg', 'اللعبة بدأت بالفعل في هذه الغرفة، لا يمكنك الدخول الآن.');
            socket.leave(roomName);
            return;
        }

        room.players.push({ id: socket.id, username });
        io.to(roomName).emit('updatePlayers', room.players);
        
        // تحديث القادم الجديد بعدد الموافقات الحالي
        io.to(roomName).emit('updateStartRequests', room.startRequests.length);
    });

    // طلب بدء اللعبة أو الموافقة عليها
    socket.on('requestStartGame', () => {
        const roomName = socket.roomName;
        const room = rooms[roomName];

        if (!room || room.gameStarted) return;

        // 1. تحقق من الحد الأدنى لوجود اللاعبين في الروم (4 لاعبين)
        if (room.players.length < 4) {
            socket.emit('errorMsg', '❌ لا يمكن بدء اللعبة! الحد الأدنى للتواجد في الروم هو 4 لاعبين.');
            return;
        }

        // منع اللاعب من التصويت مرتين
        if (!room.startRequests.includes(socket.id)) {
            room.startRequests.push(socket.id);
        }
        
        // إرسال التحديث فوراً للجميع برقم دقيق
        io.to(roomName).emit('updateStartRequests', room.startRequests.length);

        // 2. إذا وصلت الموافقات إلى 3 أو أكثر، يبدأ القيم تلقائياً
        if (room.startRequests.length >= 3) {
            room.gameStarted = true;
            room.isVoting = false;
            room.notes = {};
            room.votes = {};
            room.startRequests = []; // تصفير كامل للمستقبل

            const words = ['تفاحة', 'سيارة', 'مدرسة', 'مستشفى', 'هاتف', 'طائرة'];
            room.word = words[Math.floor(Math.random() * words.length)];
            
            const spyIndex = Math.floor(Math.random() * room.players.length);
            room.spy = room.players[spyIndex];

            room.players.forEach((player) => {
                if (player.id === room.spy.id) {
                    io.to(player.id).emit('gameRole', { role: 'spy', word: '🕵️‍♂️ أنت الجاسوس! حاول التخمين.' });
                } else {
                    io.to(player.id).emit('gameRole', { role: 'citizen', word: `🍎 الكلمة السرية هي: ${room.word}` });
                }
            });

            startNotesPhase(roomName);
        }
    });

    // استقبال الملاحظات من اللاعبين
    socket.on('sendNote', (noteText) => {
        const roomName = socket.roomName;
        const room = rooms[roomName];
        if (!room || !room.gameStarted) return;

        room.notes[socket.id] = { username: socket.username, text: noteText || 'لم يكتب شيئاً' };

        if (socket.kickTimeout) clearTimeout(socket.kickTimeout);

        if (Object.keys(room.notes).length === room.players.length) {
            io.to(roomName).emit('allNotesRevealed', Object.values(room.notes));
            room.isVoting = true;
            room.votes = {};
            io.to(roomName).emit('startVotingPhase', room.players);
        }
    });

    // استقبال التصويت ضد الجاسوس
    socket.on('castVote', (votedPlayerId) => {
        const roomName = socket.roomName;
        const room = rooms[roomName];
        if (!room || !room.isVoting) return;

        room.votes[socket.id] = votedPlayerId;

        if (Object.keys(room.votes).length === room.players.length) {
            checkVotes(roomName);
        }
    });

    // معالجة الخروج المفاجئ والـ Glitches
    socket.on('disconnect', () => {
        const roomName = socket.roomName;
        const username = socket.username;
        const room = rooms[roomName];

        if (socket.kickTimeout) clearTimeout(socket.kickTimeout);

        if (room) {
            room.players = room.players.filter(p => p.id !== socket.id);
            // إزالة صوته من مصفوفة بدء اللعبة إذا غادر قبل التشغيل
            room.startRequests = room.startRequests.filter(id => id !== socket.id);
            delete room.notes[socket.id];
            delete room.votes[socket.id];

            io.to(roomName).emit('updatePlayers', room.players);
            
            if (!room.gameStarted) {
                io.to(roomName).emit('updateStartRequests', room.startRequests.length);
            }

            if (room.gameStarted) {
                if (room.spy && room.spy.id === socket.id) {
                    io.to(roomName).emit('gameEnded', `🚨 خرج الجاسوس (${username}) من اللعبة! فاز المواطنون تلقائياً.`);
                    resetRoom(room);
                } 
                else if (room.players.length < 3) {
                    io.to(roomName).emit('gameEnded', `⚠️ انتهت اللعبة بسبب خروج اللاعب (${username}) وهبوط عدد المشتركين تحت الـ 3.`);
                    resetRoom(room);
                }
                else if (room.isVoting) {
                    if (Object.keys(room.votes).length === room.players.length && room.players.length > 0) {
                        checkVotes(roomName);
                    }
                }
            }

            if (room.players.length === 0) {
                delete rooms[roomName];
            }
        }
    });
});

function startNotesPhase(roomName) {
    const room = rooms[roomName];
    room.notes = {};
    
    io.to(roomName).emit('startNotesTimer', 30);

    room.players.forEach(player => {
        const playerSocket = io.sockets.sockets.get(player.id);
        if (playerSocket) {
            playerSocket.kickTimeout = setTimeout(() => {
                if (!room.notes[player.id]) {
                    playerSocket.emit('kicked', '⏰ تم طردك تلقائياً من الروم بسبب تأخرك في كتابة الملاحظة (30 ثانية)!');
                    playerSocket.leave(roomName);
                    
                    room.players = room.players.filter(p => p.id !== player.id);
                    io.to(roomName).emit('updatePlayers', room.players);
                    
                    if (room.players.length < 3) {
                        io.to(roomName).emit('gameEnded', '⚠️ انتهت اللعبة بسبب طرد اللاعبين المتأخرين ونقص العدد الإجمالي.');
                        resetRoom(room);
                    } else if (Object.keys(room.notes).length === room.players.length) {
                        io.to(roomName).emit('allNotesRevealed', Object.values(room.notes));
                        room.isVoting = true;
                        io.to(roomName).emit('startVotingPhase', room.players);
                    }
                }
            }, 30000);
        }
    });
}

function checkVotes(roomName) {
    const room = rooms[roomName];
    const voteCounts = {};

    Object.values(room.votes).forEach(votedId => {
        voteCounts[votedId] = (voteCounts[votedId] || 0) + 1;
    });

    let highestVotedId = null;
    let maxVotes = 0;
    for (const [id, count] of Object.entries(voteCounts)) {
        if (count > maxVotes) {
            maxVotes = count;
            highestVotedId = id;
        }
    }

    const votedPlayer = room.players.find(p => p.id === highestVotedId);

    if (votedPlayer && votedPlayer.id === room.spy.id) {
        io.to(roomName).emit('gameEnded', `🎉 كفو! تم كشف الجاسوس بنجاح وهو: [ ${votedPlayer.username} ]. فاز المواطنون!`);
    } else {
        io.to(roomName).emit('gameEnded', `💥 خسارة! صوّتّم ضد الشخص الخطأ. الجاسوس الحقيقي كان: [ ${room.spy.username} ]. فاز الجاسوس!`);
    }

    resetRoom(room);
}

function resetRoom(room) {
    room.gameStarted = false;
    room.isVoting = false;
    room.spy = null;
    room.word = '';
    room.notes = {};
    room.votes = {};
    room.startRequests = []; // إفراغ المصفوفة بنجاح
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`السيرفر يعمل بنجاح`));
