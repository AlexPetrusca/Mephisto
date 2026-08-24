// The bot-game library: the games the Bot Tricks dropdown offers.
//
// A PLAIN DATA FILE, loaded by the panel AND by the settings page, because both offer the same
// list and eight game names duplicated in two places is how they drift apart. Nothing here needs
// chess.js: the replay, the PGN parsing and the colour matching all live with it in popup.js.
// chess.com decides a game against a bot IN THE BROWSER, and its board object will take moves for
// both sides, so a whole game can be handed to it move by move. The trick is only the delivery --
// the chess is a fixed line, replayed.
//
// EVERY LINE MUST END THE GAME. A resignation stops with the bot still to move, and the bot then
// answers for real -- there is no way to make it resign. Checkmate is what every entry here uses;
// a pasted game may also end in a draw the client claims itself (stalemate, threefold, fifty-move,
// dead position). That single rule is what decides which famous games can be here at all, and it
// is pinned in the suite by replaying each line through chess.js.
//
// The winner is recorded rather than derived so the page can refuse a line meant for the other
// colour before it plays a single move -- the wrong line delivers the mate to the BOT.
self.MephistoBotGames = [
    // The two schoolyard mates. Fast, and the reason to prefer anything else in this list: a
    // four-move win against a 3200-rated bot, every time, is the most obvious pattern available.
    {id: 'scholars', name: "Scholar's Mate", winner: 'white',
        moves: ['e4', 'e5', 'Qf3', 'Nc6', 'Bc4', 'Nb8', 'Qxf7#']},
    {id: 'fools', name: "Fool's Mate", winner: 'black',
        moves: ['f3', 'e5', 'g4', 'Qh4#']},
    // Légal's Mate, 1750 -- the queen sacrifice that is not a sacrifice.
    {id: 'legal', name: "Légal's Mate (1750)", winner: 'white',
        moves: ['e4', 'e5', 'Nf3', 'd6', 'Bc4', 'Bg4', 'Nc3', 'g6', 'Nxe5', 'Bxd1', 'Bxf7+', 'Ke7', 'Nd5#']},
    // The Blackburne Shilling trap, black's answer to the same idea.
    {id: 'blackburne', name: 'Blackburne Shilling Trap', winner: 'black',
        moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nd4', 'Nxe5', 'Qg5', 'Nxf7', 'Qxg2', 'Rf1', 'Qxe4+', 'Be2', 'Nf3#']},
    // The Englund Gambit trap. Black gives the e-pawn and mates on c1 by move 8 if the queen is
    // taken -- the second trap here, and the second one black springs.
    {id: 'englund', name: "Englund Gambit Trap", winner: 'black',
        moves: ['d4', 'e5', 'dxe5', 'Nc6', 'Nf3', 'Qe7', 'Bf4', 'Qb4+', 'Bd2', 'Qxb2', 'Bc3', 'Bb4', 'Qd2', 'Bxc3',
        'Qxc3', 'Qc1#']},
    // Morphy at the opera, 1858.
    {id: 'opera', name: 'The Opera Game (Morphy, 1858)', winner: 'white',
        moves: ['e4', 'e5', 'Nf3', 'd6', 'd4', 'Bg4', 'dxe5', 'Bxf3', 'Qxf3', 'dxe5', 'Bc4', 'Nf6', 'Qb3', 'Qe7',
            'Nc3', 'c6', 'Bg5', 'b5', 'Nxb5', 'cxb5', 'Bxb5+', 'Nbd7', 'O-O-O', 'Rd8', 'Rxd7', 'Rxd7', 'Rd1', 'Qe6',
            'Bxd7+', 'Nxd7', 'Qb8+', 'Nxb8', 'Rd8#']},
    // Anderssen-Kieseritzky, London 1851.
    {id: 'immortal', name: 'The Immortal Game (1851)', winner: 'white',
        moves: ['e4', 'e5', 'f4', 'exf4', 'Bc4', 'Qh4+', 'Kf1', 'b5', 'Bxb5', 'Nf6', 'Nf3', 'Qh6', 'd3', 'Nh5',
            'Nh4', 'Qg5', 'Nf5', 'c6', 'g4', 'Nf6', 'Rg1', 'cxb5', 'h4', 'Qg6', 'h5', 'Qg5', 'Qf3', 'Ng8', 'Bxf4',
            'Qf6', 'Nc3', 'Bc5', 'Nd5', 'Qxb2', 'Bd6', 'Bxg1', 'e5', 'Qxa1+', 'Ke2', 'Na6', 'Nxg7+', 'Kd8', 'Qf6+',
            'Nxf6', 'Be7#']},
    // Anderssen-Dufresne, Berlin 1852.
    {id: 'evergreen', name: 'The Evergreen Game (1852)', winner: 'white',
        moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'b4', 'Bxb4', 'c3', 'Ba5', 'd4', 'exd4', 'O-O', 'd3',
            'Qb3', 'Qf6', 'e5', 'Qg6', 'Re1', 'Nge7', 'Ba3', 'b5', 'Qxb5', 'Rb8', 'Qa4', 'Bb6', 'Nbd2', 'Bb7',
            'Ne4', 'Qf5', 'Bxd3', 'Qh5', 'Nf6+', 'gxf6', 'exf6', 'Rg8', 'Rad1', 'Qxf3', 'Rxe7+', 'Nxe7', 'Qxd7+',
            'Kxd7', 'Bf5+', 'Ke8', 'Bd7+', 'Kf8', 'Bxe7#']},
    // Edward Lasker's king walk: the black king is marched from h8 all the way to g1 and mated
    // there, by a king move.
    {id: 'lasker_thomas', name: "Lasker vs Thomas, 1912", winner: 'white',
        moves: ['d4', 'e6', 'Nf3', 'f5', 'Nc3', 'Nf6', 'Bg5', 'Be7', 'Bxf6', 'Bxf6', 'e4', 'fxe4', 'Nxe4', 'b6', 'Ne5',
        'O-O', 'Bd3', 'Bb7', 'Qh5', 'Qe7', 'Qxh7+', 'Kxh7', 'Nxf6+', 'Kh6', 'Neg4+', 'Kg5', 'h4+', 'Kf4', 'g3+',
        'Kf3', 'Be2+', 'Kg2', 'Rh2+', 'Kg1', 'Kd2#']},
    // Canal's Peruvian Immortal: both rooks and the queen handed over, mate delivered by the one
    // minor piece left.
    {id: 'peruvian', name: "The Peruvian Immortal (1934)", winner: 'white',
        moves: ['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qa5', 'd4', 'c6', 'Nf3', 'Bg4', 'Bf4', 'e6', 'h3', 'Bxf3', 'Qxf3',
        'Bb4', 'Be2', 'Nd7', 'a3', 'O-O-O', 'axb4', 'Qxa1+', 'Kd2', 'Qxh1', 'Qxc6+', 'bxc6', 'Ba6#']},
    // Byrne-Fischer, New York 1956. The longest line here, and the only famous BLACK mate in it.
    {id: 'century', name: 'Game of the Century (Fischer, 1956)', winner: 'black',
        moves: ['Nf3', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7', 'd4', 'O-O', 'Bf4', 'd5', 'Qb3', 'dxc4', 'Qxc4', 'c6',
            'e4', 'Nbd7', 'Rd1', 'Nb6', 'Qc5', 'Bg4', 'Bg5', 'Na4', 'Qa3', 'Nxc3', 'bxc3', 'Nxe4', 'Bxe7', 'Qb6',
            'Bc4', 'Nxc3', 'Bc5', 'Rfe8+', 'Kf1', 'Be6', 'Bxb6', 'Bxc4+', 'Kg1', 'Ne2+', 'Kf1', 'Nxd4+', 'Kg1',
            'Ne2+', 'Kf1', 'Nc3+', 'Kg1', 'axb6', 'Qb4', 'Ra4', 'Qxb6', 'Nxd1', 'h3', 'Rxa2', 'Kh2', 'Nxf2',
            'Re1', 'Rxe1', 'Qd8+', 'Bf8', 'Nxe1', 'Bd5', 'Nf3', 'Ne4', 'Qb8', 'b5', 'h4', 'h5', 'Ne5', 'Kg7',
            'Kg1', 'Bc5+', 'Kf1', 'Ng3+', 'Ke1', 'Bb4+', 'Kd1', 'Bb3+', 'Kc1', 'Ne2+', 'Kb1', 'Nc3+', 'Kc1', 'Rc2#']},

    // ---- TOP ENGINE GAMES, FINISHED OUT ----------------------------------------------------------
    // A published engine game CANNOT be replayed at a bot as it stands: engines resign or are
    // adjudicated, so every one of them stops with the loser still to move -- and the bot would then
    // answer for real. Each of these is the real game up to the point it was given up, followed by
    // Stockfish 18 playing BOTH sides at depth 18 until mate. The name says "played to mate" for
    // exactly that reason: the finish is not what the original engines played, and pretending
    // otherwise would be inventing a famous game. The published prefix is untouched.
    {id: 'db97', name: "Deep Blue vs Kasparov, 1997 (played to mate)", winner: 'white',
        moves: ['e4', 'c6', 'd4', 'd5', 'Nc3', 'dxe4', 'Nxe4', 'Nd7', 'Ng5', 'Ngf6', 'Bd3', 'e6', 'N1f3', 'h6', 'Nxe6',
        'Qe7', 'O-O', 'fxe6', 'Bg6+', 'Kd8', 'Bf4', 'b5', 'a4', 'Bb7', 'Re1', 'Nd5', 'Bg3', 'Kc8', 'axb5',
        'cxb5', 'Qd3', 'Bc6', 'Bf5', 'exf5', 'Rxe7', 'Bxe7', 'c4', 'N5f6', 'Qxf5', 'Bd8', 'd5', 'Bb7', 'Rc1',
        'Ba5', 'Ne5', 'Bd2', 'Rd1', 'bxc4', 'Rxd2', 'Re8', 'f3', 'Rxe5', 'Bxe5', 'a5', 'Bxf6', 'gxf6', 'Qe4',
        'Ra6', 'Qxc4+', 'Kb8', 'd6', 'Rc6', 'Qb5', 'a4', 'Rd1', 'Kc8', 'Qxa4', 'h5', 'h4', 'f5', 'b4', 'Nb6',
        'Qa5', 'Nd7', 'Re1', 'Ba6', 'b5', 'Rxd6', 'Rc1+', 'Nc5', 'Rxc5+', 'Kd7', 'Rc7+', 'Ke6', 'Qe1+', 'Kd5',
        'Qd2+', 'Ke6', 'Qe3+', 'Kf6', 'Qe7+', 'Kg6', 'Qxd6#']},
    {id: 'db96', name: "Deep Blue vs Kasparov, 1996 (played to mate)", winner: 'white',
        moves: ['e4', 'c5', 'c3', 'd5', 'exd5', 'Qxd5', 'd4', 'Nf6', 'Nf3', 'Bg4', 'Be2', 'e6', 'h3', 'Bh5', 'O-O',
        'Nc6', 'Be3', 'cxd4', 'cxd4', 'Bb4', 'a3', 'Ba5', 'Nc3', 'Qd6', 'Nb5', 'Qe7', 'Ne5', 'Bxe2', 'Qxe2',
        'O-O', 'Rac1', 'Rac8', 'Bg5', 'Bb6', 'Bxf6', 'gxf6', 'Nc4', 'Rfd8', 'Nxb6', 'axb6', 'Rfd1', 'f5', 'Qe3',
        'Qf6', 'd5', 'Rxd5', 'Rxd5', 'exd5', 'b3', 'Kh8', 'Qxb6', 'Rg8', 'Qc5', 'd4', 'Nd6', 'f4', 'Nxb7',
        'Ne5', 'Qd5', 'f3', 'g3', 'Nd3', 'Rc7', 'Re8', 'Nd6', 'Re1+', 'Kh2', 'Nxf2', 'Nxf7+', 'Kg7', 'Ng5+',
        'Kh6', 'Rxh7+', 'Kg6', 'Qg8+', 'Kf5', 'Nxf3', 'Re6', 'Rh4', 'Qxh4', 'Nxh4+', 'Kf6', 'Qf8+', 'Ke5',
        'Qxf2', 'Kd5', 'Nf5', 'Re4', 'g4', 'd3', 'Qg2', 'Ke5', 'Qg3+', 'Rf4', 'Qxd3', 'Rxf5', 'gxf5', 'Kf6',
        'Qd5', 'Kg7', 'Qe6', 'Kf8', 'Kg3', 'Kg7', 'Qe7+', 'Kh8', 'f6', 'Kg8', 'Qg7#']},
    {id: 'az10', name: "AlphaZero vs Stockfish, G10 (played to mate)", winner: 'white',
        moves: ['Nf3', 'Nf6', 'd4', 'e6', 'c4', 'b6', 'g3', 'Bb7', 'Bg2', 'Be7', 'O-O', 'O-O', 'd5', 'exd5', 'Nh4',
        'c6', 'cxd5', 'Nxd5', 'Nf5', 'Nc7', 'e4', 'd5', 'exd5', 'Nxd5', 'Nc3', 'Nxc3', 'Qg4', 'g6', 'Nh6+',
        'Kg7', 'bxc3', 'Bc8', 'Qf4', 'Qd6', 'Qa4', 'g5', 'Re1', 'Kxh6', 'h4', 'f6', 'Be3', 'Bf5', 'Rad1', 'Qa3',
        'Qc4', 'b5', 'hxg5+', 'fxg5', 'Qh4+', 'Kg6', 'Qh1', 'Kg7', 'Be4', 'Bg6', 'Bxg6', 'hxg6', 'Qh3', 'Bf6',
        'Kg2', 'Qxa2', 'Rh1', 'Qg8', 'c4', 'Re8', 'Bd4', 'Bxd4', 'Rxd4', 'Rd8', 'Rxd8', 'Qxd8', 'Qe6', 'Nd7',
        'Rd1', 'Nc5', 'Rxd8', 'Nxe6', 'Rxa8', 'Kf6', 'cxb5', 'cxb5', 'Kf3', 'Nd4+', 'Ke4', 'Nc6', 'Rc8', 'Ne7',
        'Rb8', 'Nf5', 'g4', 'Nh6', 'f3', 'Nf7', 'Ra8', 'Nd6+', 'Kd5', 'Nc4', 'Rxa7', 'Ne3+', 'Ke4', 'Nc4',
        'Ra6+', 'Kg7', 'Rc6', 'Kf7', 'Rc5', 'Ke6', 'Rxg5', 'Kf6', 'Rc5', 'g5', 'Kd4', 'Na3', 'Kd3', 'Kg6',
        'Rc6+', 'Kf7', 'Rb6', 'Ke8', 'Rg6', 'Kd7', 'Rxg5', 'Kd6', 'Rf5', 'Kd7', 'g5', 'b4', 'Ra5', 'Kd6',
        'Ra6+', 'Kc5', 'g6', 'Nc4', 'Rc6+', 'Kxc6', 'Kxc4', 'Kd6', 'g7', 'b3', 'Kc3', 'b2', 'Kxb2', 'Ke6',
        'g8=Q+', 'Kf6', 'Kc3', 'Ke5', 'Qg5+', 'Ke6', 'Kd4', 'Kd6', 'Qd5+', 'Ke7', 'Ke5', 'Kf8', 'Qd7', 'Kg8',
        'Kf6', 'Kh8', 'Qg7#']},
    {id: 'az1', name: "Stockfish vs AlphaZero, G1 (played to mate)", winner: 'black',
        moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'Nf6', 'd3', 'Bc5', 'Bxc6', 'dxc6', 'O-O', 'Nd7', 'Nbd2', 'O-O', 'Qe1',
        'f6', 'Nc4', 'Rf7', 'a4', 'Bf8', 'Kh1', 'Nc5', 'a5', 'Ne6', 'Ncxe5', 'fxe5', 'Nxe5', 'Rf6', 'Ng4',
        'Rf7', 'Ne5', 'Re7', 'a6', 'c5', 'f4', 'Qe8', 'axb7', 'Bxb7', 'Qa5', 'Nd4', 'Qc3', 'Re6', 'Be3', 'Rb6',
        'Nc4', 'Rb4', 'b3', 'a5', 'Rxa5', 'Rxa5', 'Nxa5', 'Ba6', 'Bxd4', 'Rxd4', 'Nc4', 'Rd8', 'g3', 'h6',
        'Qa5', 'Bc8', 'Qxc7', 'Bh3', 'Rg1', 'Rd7', 'Qe5', 'Qxe5', 'Nxe5', 'Ra7', 'Nc4', 'g5', 'Rc1', 'Bg7',
        'Ne5', 'Ra8', 'Nf3', 'Bb2', 'Rb1', 'Bc3', 'Ng1', 'Bd7', 'Ne2', 'Bd2', 'Rd1', 'Be3', 'Kg2', 'Bg4', 'Re1',
        'Bd2', 'Rf1', 'Ra2', 'h3', 'Bxe2', 'Rf2', 'Bxf4', 'Rxe2', 'Be5', 'Rf2', 'Kg7', 'g4', 'Bd4', 'Re2',
        'Kf6', 'e5+', 'Bxe5', 'Kf3', 'Ra1', 'Rf2', 'Re1', 'Kg2+', 'Bf4', 'c3', 'Rc1', 'd4', 'Rxc3', 'dxc5',
        'Rxc5', 'b4', 'Rc3', 'h4', 'Ke5', 'hxg5', 'hxg5', 'Re2+', 'Kf6', 'Kf2', 'Be5', 'Ra2', 'Rc4', 'Ra6+',
        'Ke7', 'Ra5', 'Ke6', 'Ra6+', 'Bd6', 'b5', 'Rxg4', 'Ra8', 'Rb4', 'Ra6', 'Rxb5', 'Kf3', 'Rb4', 'Ke3',
        'g4', 'Ra1', 'Rb3+', 'Ke4', 'Rb4+', 'Ke3', 'g3', 'Re1', 'Be5', 'Re2', 'Kf5', 'Kd3', 'Rg4', 'Rg2',
        'Rd4+', 'Kc3', 'Rf4+', 'Kd3', 'Rf3+', 'Kc4', 'Rf2', 'Rg1', 'g2', 'Kc5', 'Bh2', 'Rxg2', 'Rxg2', 'Kd4',
        'Be5+', 'Kd5', 'Rg4', 'Kc6', 'Ke6', 'Kb5', 'Kd5', 'Kb6', 'Rb4+', 'Ka5', 'Kc5', 'Ka6', 'Rb1', 'Ka7',
        'Kc6', 'Ka6', 'Ra1#']},

    // ---- CARLSEN-CARUANA 2018, THE SAME TREATMENT ------------------------------------------------
    // All TWELVE classical games of that match were drawn BY AGREEMENT, which no client can claim --
    // agreement is not a position, it is two people deciding -- so not one of them is replayable as
    // it stands. The wins in the match are the rapid tie-breaks, and those ended in resignation. So
    // again: the real game, then Stockfish 18 playing both sides to a finish.
    //
    // The classical game is the exception and the long one. Played on from where the two of them
    // shook hands, it repeats into a THREEFOLD at move 122 -- a draw the client claims itself, no
    // agreement needed. It wins nothing. It is here because it is 122 moves of Carlsen.
    {id: 'cc_rapid1', name: "Carlsen vs Caruana, 2018 tie-break (played to mate)", winner: 'white',
        moves: ['c4', 'e5', 'Nc3', 'Nf6', 'g3', 'Bb4', 'e4', 'O-O', 'Nge2', 'c6', 'Bg2', 'a6', 'O-O', 'b5', 'd4', 'd6',
        'a3', 'Bxc3', 'Nxc3', 'bxc4', 'dxe5', 'dxe5', 'Na4', 'Be6', 'Qxd8', 'Rxd8', 'Be3', 'Nbd7', 'f3', 'Rab8',
        'Rac1', 'Rb3', 'Rfe1', 'Ne8', 'Bf1', 'Nd6', 'Rcd1', 'Nb5', 'Nc5', 'Rxb2', 'Nxe6', 'fxe6', 'Bxc4', 'Nd4',
        'Bxd4', 'exd4', 'Bxe6+', 'Kf8', 'Rxd4', 'Ke7', 'Rxd7+', 'Rxd7', 'Bxd7', 'Kxd7', 'Rd1+', 'Ke6', 'f4',
        'c5', 'Rd5', 'Rc2', 'h4', 'c4', 'f5+', 'Kf6', 'Rc5', 'h5', 'Kf1', 'Rc3', 'Kg2', 'Rxa3', 'Rxc4', 'Ke5',
        'Rc7', 'Kxe4', 'Re7+', 'Kxf5', 'Rxg7', 'Kf6', 'Rg5', 'a5', 'Rxh5', 'a4', 'Ra5', 'Ra1', 'Kf3', 'a3',
        'Ra6+', 'Kg7', 'Kg2', 'Ra2+', 'Kh3', 'Ra1', 'h5', 'Kh7', 'g4', 'Kg7', 'Kh4', 'a2', 'Kg5', 'Kf7', 'h6',
        'Rb1', 'Ra7+', 'Kg8', 'Rxa2', 'Rb5+', 'Kg6', 'Rb6+', 'Kh5', 'Rb5+', 'g5', 'Rd5', 'Ra7', 'Rb5', 'Rg7+',
        'Kh8', 'Re7', 'Kg8', 'Kg6', 'Rb8', 'Re6', 'Ra8', 'Re5', 'Rb8', 'Ra5', 'Rc8', 'Kh5', 'Kf7', 'g6+', 'Kf8',
        'Rf5+', 'Ke7', 'h7', 'Rc2', 'g7', 'Rh2+', 'Kg6', 'Rg2+', 'Rg5', 'Rd2', 'g8=Q', 'Rd6+', 'Kh5', 'Rd1',
        'Qg7+', 'Kd6', 'Qh6+', 'Kc7', 'Rg7+', 'Rd7', 'h8=Q', 'Rxg7', 'Q8xg7+', 'Kd8', 'Qhh8#']},
    {id: 'cc_rapid2', name: "Caruana vs Carlsen, 2018 tie-break (played to mate)", winner: 'black',
        moves: ['e4', 'c5', 'Nf3', 'Nc6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'e5', 'Ndb5', 'd6', 'Nd5', 'Nxd5', 'exd5',
        'Ne7', 'c4', 'Ng6', 'Qa4', 'Bd7', 'Qb4', 'Qb8', 'h4', 'h5', 'Be3', 'a6', 'Nc3', 'a5', 'Qb3', 'a4',
        'Qd1', 'Be7', 'g3', 'Qc8', 'Be2', 'Bg4', 'Rc1', 'Bxe2', 'Qxe2', 'Qf5', 'c5', 'O-O', 'c6', 'bxc6',
        'dxc6', 'Rfc8', 'Qc4', 'Bd8', 'Nd5', 'e4', 'c7', 'Bxc7', 'Nxc7', 'Ne5', 'Nd5', 'Kh7', 'Qe2', 'Nd3+',
        'Kf1', 'Nxc1', 'Qd1', 'Nd3', 'Ne7', 'Rc1', 'Nxf5', 'Rxd1+', 'Kg2', 'Nxb2', 'Rh2', 'Nc4', 'Bg5', 'Rb8',
        'g4', 'hxg4', 'h5', 'Rd5', 'Ne3', 'Rxg5', 'Nxc4', 'g3', 'Rh3', 'd5', 'Nd6', 'gxf2+', 'Kxf2', 'Rb6',
        'Nxf7', 'Rf5+', 'Ke3', 'Rxf7', 'Kd4', 'Rf3', 'Rh1', 'Rf5', 'Kc5', 'Re6', 'Rd1', 'e3', 'h6', 'g6', 'Re1',
        'Re4', 'Re2', 'Rc4+', 'Kb6', 'Re4', 'Kb5', 'Rf2', 'Re1', 'e2', 'Kc6', 'd4', 'Kd7', 'Rf5', 'Kc6', 'd3',
        'Rb1', 'e1=Q', 'Rxe1', 'Rxe1', 'a3', 'd2', 'Kd7', 'd1=Q+', 'Kc7', 'Kxh6', 'Kb6', 'Qd7', 'Ka6', 'Re6#']},
    // THE ONE GAME HERE THAT IS NOT TOUCHED AT ALL. Every move is Carlsen's and Caruana's; it simply
    // stops where they agreed a draw, and the panel claims the draw instead of inventing a finish.
    // That is possible because the bot never gets a turn (see botExploit), so nothing can answer
    // between the last move and the claim.
    //
    // Game 9 of the twelve, and it is here because it MEASURED as the most engine-like of them:
    // 2.7 average centipawn loss over Carlsen's 56 moves, Stockfish 18 at depth 14 with each loss
    // capped at 300cp. All twelve games came out single digit (2.7 to 8.3); this was the lowest.
    // The number moves with the depth and the capping rule, so it is quoted with both or not at all.
    {id: 'cc_classic9', name: "Carlsen vs Caruana, 2018 G9 (2.7 ACPL)", winner: null, endWith: 'draw',
        moves: ['c4', 'e5', 'Nc3', 'Nf6', 'Nf3', 'Nc6', 'g3', 'd5', 'cxd5', 'Nxd5', 'Bg2', 'Bc5', 'O-O', 'O-O', 'd3',
        'Re8', 'Bg5', 'Nxc3', 'bxc3', 'f6', 'Bc1', 'Be6', 'Bb2', 'Bb6', 'd4', 'Bd5', 'Qc2', 'exd4', 'cxd4',
        'Be4', 'Qb3+', 'Bd5', 'Qd1', 'Bxf3', 'Qb3+', 'Kh8', 'Bxf3', 'Nxd4', 'Bxd4', 'Qxd4', 'e3', 'Qe5', 'Bxb7',
        'Rad8', 'Rad1', 'Qe7', 'h4', 'g6', 'h5', 'gxh5', 'Qc4', 'f5', 'Bf3', 'h4', 'Rxd8', 'Rxd8', 'gxh4',
        'Rg8+', 'Kh1', 'Qf6', 'Qf4', 'Bc5', 'Rg1', 'Rxg1+', 'Kxg1', 'Bd6', 'Qa4', 'f4', 'Qxa7', 'fxe3', 'Qxe3',
        'Qxh4', 'a4', 'Qf6', 'Bd1', 'Qe5', 'Qxe5+', 'Bxe5', 'a5', 'Kg7', 'a6', 'Bd4', 'Kg2', 'Kf6', 'f4', 'Bb6',
        'Kf3', 'h6', 'Ke4', 'Ba7', 'Bg4', 'Bg1', 'Kd5', 'Bb6', 'Kc6', 'Be3', 'Kb7', 'Bb6', 'Bh3', 'Be3', 'Kc6',
        'Bb6', 'Kd5', 'Ba7', 'Ke4', 'Bb6', 'Bf1', 'Ke6', 'Bc4+', 'Kf6', 'Bd3', 'Ke6']},
];
