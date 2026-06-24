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
                isVoting: false
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
    });

    // بدء اللعبة
    socket.on('startGame', () => {
        const roomName = socket.roomName;
        const room = rooms[roomName];

        if (!room || room.gameStarted) return;

        // التحقق من الحد الأدنى لبدء اللعبة
        if (room.players.length < 3) {
            socket.emit('errorMsg', 'لا يمكن بدء اللعبة! الحد الأدنى للاعبين هو 3 لاعبين.');
            return;
        }

        room.gameStarted = true;
        room.isVoting = false;
        room.notes = {};
        room.votes = {};

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

        // تشغيل مرحلة الملاحظات تلقائياً مع المؤقت الجديد
        startNotesPhase(roomName);
    });

    // استقبال الملاحظات من اللاعبين
    socket.on('sendNote', (noteText) => {
        const roomName = socket.roomName;
        const room = rooms[roomName];
        if (!room || !room.gameStarted) return;

        room.notes[socket.id] = { username: socket.username, text: noteText || 'لم يكتب شيئاً' };

        if (socket.kickTimeout) clearTimeout(socket.kickTimeout);

        // إذا أرسل الجميع الملاحظات، يتم عرضها والبدء بالتصويت فوراً
        if (Object.keys(room.notes).length === room.players.length) {
            io.to(roomName).emit('allNotesRevealed', Object.values(room.notes));
            
            room.isVoting = true;
            room.votes = {};
            io.to(roomName).emit('startVotingPhase', room.players);
        }
    });

    // استقبال التصويت
    socket.on('castVote', (votedPlayerId) => {
        const roomName = socket.roomName;
        const room = rooms[roomName];
        if (!room || !room.isVoting) return;

        room.votes[socket.id] = votedPlayerId;

        if (Object.keys(room.votes).length === room.players.length) {
            checkVotes(roomName);
        }
    });

    // حماية اللعبة من خروج اللاعبين المفاجئ أو طردهم (Glitches)
    socket.on('disconnect', () => {
        const roomName = socket.roomName;
        const username = socket.username;
        const room = rooms[roomName];

        if (socket.kickTimeout) clearTimeout(socket.kickTimeout);

        if (room) {
            room.players = room.players.filter(p => p.id !== socket.id);
            delete room.notes[socket.id];
            delete room.votes[socket.id];

            io.to(roomName).emit('updatePlayers', room.players);

            if (room.gameStarted) {
                // 1. إذا خرج الجاسوس ينتهي القيم بفوز المواطنين
                if (room.spy && room.spy.id === socket.id) {
                    io.to(roomName).emit('gameEnded', `🚨 خرج الجاسوس (${username}) من اللعبة! فاز المواطنون تلقائياً.`);
                    resetRoom(room);
                } 
                // 2. إذا خرج لاعب عادي وقل عدد اللاعبين عن الحد الأدنى (3 لاعبين) ينتهي القيم فوراً
                else if (room.players.length < 3) {
                    io.to(roomName).emit('gameEnded', `⚠️ انتهت اللعبة بسبب خروج اللاعب (${username}) وهبوط العدد عن الحد الأدنى (3 لاعبين).`);
                    resetRoom(room);
                }
                // 3. تحديث فحص التصويت إذا كان جارياً لمنع تعليق القيم بانتظار الغائب
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

// نظام مؤقت الملاحظات وطرد من يتأخر عن 30 ثانية
function startNotesPhase(roomName) {
    const room = rooms[roomName];
    room.notes = {};
    
    io.to(roomName).emit('startNotesTimer', 30);

    room.players.forEach(player => {
        const playerSocket = io.sockets.sockets.get(player.id);
        if (playerSocket) {
            playerSocket.kickTimeout = setTimeout(() => {
                // إذا انتهى الوقت ولم يرسل الملاحظة، يتم طرده من الروم
                if (!room.notes[player.id]) {
                    playerSocket.emit('kicked', '⏰ تم طردك تلقائياً من الروم بسبب تأخرك في كتابة الملاحظة (30 ثانية)!');
                    playerSocket.leave(roomName);
                    
                    // إخراجه رسمياً من مصفوفة اللاعبين
                    room.players = room.players.filter(p => p.id !== player.id);
                    io.to(roomName).emit('updatePlayers', room.players);
                    
                    // فحص فوري: هل طرده تسبب في هبوط العدد عن الحد الأدنى؟
                    if (room.players.length < 3) {
                        io.to(roomName).emit('gameEnded', '⚠️ انتهت اللعبة بعد طرد اللاعبين المتأخرين وهبوط العدد الإجمالي عن 3 لاعبين.');
                        resetRoom(room);
                    } 
                    // إذا كان الباقون قد أرسلوا ملاحظاتهم بعد طرده، ننتقل للتصويت مباشرة
                    else if (Object.keys(room.notes).length === room.players.length) {
                        io.to(roomName).emit('allNotesRevealed', Object.values(room.notes));
                        room.isVoting = true;
                        io.to(roomName).emit('startVotingPhase', room.players);
                    }
                }
            }, 30000); // 30 ثانية
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
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`السيرفر يعمل بنجاح`));