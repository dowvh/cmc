/* =========================================================
   CineNoite — catálogo embutido

   f(id, título, gênero, ano, minutos, idade, sinopse, extras)

   • id  = identificador ESTÁVEL do filme. É ele que guarda o progresso e a
           "Minha lista" no navegador. Não mude o id de um filme já publicado
           (o título pode mudar à vontade).
   • Por padrão, o id também define os nomes dos arquivos:
       capas/<id>.jpg · legendas/<id>-pt.vtt · https://<seu-PC>/<id>.mp4
   • extras (opcionais): h (matiz 0-360), x (posição do brilho, ex. "50%"),
       capa, video (nome do arquivo no seu PC ou link https completo), legenda.
   ========================================================= */
window.CATALOGO = (() => {
  const f = (id, t, g, y, m, a, p, extra = {}) => ({
    id, t, g, y, m, a, p,
    h: 20, x: "70%",
    capa: id + ".jpg",
    video: id + ".mp4",
    legenda: id + "-pt.vtt",
    ...extra
  });

  return [
    f("au-hasard-balthazar", "Au Hasard Balthazar", "Drama", 1966, 95, "14",
      "Na França rural, a vida de um burro de carga reflete as alegrias, crueldades e sofrimentos dos vários donos pelos quais passa.",
      { h: 18, x: "50%", video: "au-hasard-balthazar-web.mp4" }),

    f("late-spring", "Late Spring", "Drama", 1949, 108, "L",
      "Uma jovem de 27 anos vive tranquilamente cuidando de seu pai viúvo e resiste à pressão para se casar, até que ele finge querer se casar novamente para incentivá-la a seguir a própria vida.",
      { video: "late-spring-web.mp4" }),

    f("gertrud", "Gertrud", "Drama", 1964, 116, "12",
      "Na Estocolmo do início do século XX, uma mulher abandona o casamento e desafia as convenções sociais em busca de um amor absoluto.",
      { video: "gertrud-web.mp4" }),

    f("diary-of-a-country-priest", "Diary of a Country Priest", "Drama", 1951, 115, "12",
      "Em uma pequena paróquia no interior da França, um jovem padre enfrenta problemas de saúde, a hostilidade dos moradores e profundas dúvidas espirituais."),

    f("3-godfathers", "3 Godfathers", "Faroeste", 1948, 106, "L",
      "Em fuga pelo deserto após um assalto a banco, três fora da lei encontram uma mulher moribunda e juram proteger seu bebê recém-nascido até a cidade mais próxima."),

    f("shane", "Shane", "Faroeste", 1953, 118, "L",
      "Um pistoleiro solitário tenta deixar seu passado violento para trás ao trabalhar em uma fazenda, mas acaba defendendo uma família de colonos contra um poderoso criador de gado.",
      { video: "shane-web.mp4" }),

    f("germany-year-zero", "Germany, Year Zero", "Drama", 1948, 78, "12",
      "Em uma Berlim devastada no pós-guerra, um menino de doze anos luta para ajudar sua família a sobreviver, mas acaba influenciado por um antigo professor nazista."),

    f("street-of-shame", "Street of Shame", "Drama", 1956, 85, "14",
      "Em um bordel de Tóquio na década de 1950, cinco mulheres de diferentes origens lutam para pagar suas dívidas e sustentar suas famílias enquanto o parlamento debate a proibição da prostituição."),

    f("duck-amuck", "Duck Amuck", "Animação", 1953, 7, "L",
      "Patolino tenta estrelar um desenho animado, mas um animador invisível e sádico muda constantemente o cenário, o figurino, a trilha sonora e até a própria aparência do pato.",
      { h: 42, x: "50%", video: "https://dn721907.ca.archive.org/0/items/duck-amuck-1953-restored/S18E006_Duck%20Amuck.ia.mp4" }),

    f("yi-yi", "Yi Yi", "Drama", 2000, 173, "16",
      "Em um apartamento em Taipé, três gerações da família Jian enfrentam crises afetivas, dilemas profissionais e descobertas existenciais — do pai NJ, que reencontra um amor do passado, aos filhos adolescentes e caçula — enquanto a avó entra em coma após um casamento que marca o início de novas fases.",
      { video: "https://archive.org/download/as-coisas-simples-da-vida-2000-8-1/AS%20COISAS%20SIMPLES%20DA%20VIDA%20%282000%29%20%5B8%2C1%5D.mp4" }),

    f("the-quiet-man", "The Quiet Man", "Romance", 1952, 129, "L",
      "Um boxeador americano aposentado retorna à sua terra natal na Irlanda em busca de paz, mas se apaixona pela temperamental Mary Kate e precisa enfrentar os costumes locais e a teimosia do irmão dela para conquistar o dote e a felicidade do casal.",
      { legenda: "the-quiet-man-pt2.vtt" }),

    f("journey-to-italy", "Journey to Italy", "Drama", 1954, 86, "L",
      "Um casal britânico em crise viaja a Nápoles para vender uma propriedade herdada, mas o distanciamento entre os dois se aprofunda enquanto exploram a cidade, as ruínas de Pompeia e confrontam o vazio do próprio casamento.",
      { legenda: "journey-to-italy-pt2.vtt" }),

    f("millennium-mambo", "Millennium Mambo", "Drama", 2001, 119, "16",
      "Em 2011, a jovem Vicky relembra os dias da virada do milênio na vida noturna de Taipé, dividida entre o relacionamento possessivo com o namorado Hao-Hao e a aproximação de Jack, enquanto trabalha em um bar e atravessa uma juventude incerta."),

    f("king-of-new-york", "King of New York", "Crime", 1990, 103, "18",
      "Recém-saído da prisão, o implacável traficante Frank White planeja retomar o controle do submundo do crime em Nova York, eliminando gangues rivais enquanto tenta financiar a construção de um hospital para os mais pobres.",
      { h: 35, x: "50%", legenda: "king-of-new-york-pt2.vtt" }),

    f("sans-soleil", "Sans Soleil", "Documentário", 1983, 100, "14",
      "Por meio de cartas narradas por uma voz feminina, um viajante registra imagens e reflexões sobre tempo, memória e identidade entre o Japão, a Guiné-Bissau, a Islândia e São Francisco em um ensaio cinematográfico híbrido."),

    f("barry-lyndon", "Barry Lyndon", "Drama", 1975, 185, "14",
      "Na Europa do século XVIII, o jovem irlandês Redmond Barry ascende socialmente por meio de duelos, aventuras militares e um casamento aristocrático por interesse, mas sua vaidade e ambição o arrastam para a queda.",
      { video: "https://archive.org/download/barry.-lyndon.-1975.-remastered.-1080p.-blu-ray.x-265-rarbg/Barry.Lyndon.1975.REMASTERED.1080p.BluRay.x265-RARBG.mp4" }),

    f("secret-defense", "Secret Defense", "Drama", 1998, 170, "14",
      "Após descobrir que a morte aparente de seu pai por suicídio anos atrás pode ter sido um assassinato, a cientista Sylvie decide confrontar Walser, o sócio dele, embarcando em uma tensa jornada de trem e dilemas morais para vingar a família.",
      { legenda: "secret-defense-pt2.vtt" }),

    f("the-girl-cant-help-it", "The Girl Can't Help It", "Comédia", 1956, 99, "12",
      "Contratado por um gângster para transformar sua namorada sem talento em uma estrela da música, um agente de talentos alcoólatra acaba se apaixonando por ela em meio à explosão do rock and roll."),

    f("weekend", "Weekend", "Comédia", 1967, 105, "18",
      "Um casal burguês parisiense parte para o interior em busca da herança da família da esposa, mas a viagem de fim de semana mergulha no caos total com engarrafamentos surrealistas, acidentes violentos e o colapso da civilização moderna.",
      { legenda: "weekend-pt2.vtt" }),

    f("7-women", "7 Women", "Drama", 1966, 87, "14",
      "Em 1935, no norte da China, a chegada de uma médica franca e cética abala a rotina rígida de uma missão americana isolada quando um senhor da guerra e seus bandidos avançam sobre a região."),

    f("close-up", "Close-Up", "Documentário", 1990, 98, "L",
      "Em Teerã, o cinéfilo desempregado Hossein Sabzian engana uma família ao se passar pelo famoso diretor Mohsen Makhmalbaf, levando à sua prisão e a um julgamento real que mistura ficção e realidade para explorar identidade, arte e dignidade humana.",
      { legenda: "close-up-pt2.vtt" }),

    f("fat-girl", "Fat Girl", "Drama", 2001, 86, "18",
      "Durante as férias de verão na França, duas irmãs adolescentes com relações complexas entre si — a mais nova, acima do peso e observadora, e a mais velha, atraente e impulsiva — vivem experiências marcantes de amadurecimento que culminam em um encontro inesperado e perturbador."),

    f("showgirls", "Showgirls", "Drama", 1995, 128, "18",
      "A jovem e ambiciosa Nomi Malone chega a Las Vegas com o sonho de se tornar uma grande dançarina, mas logo descobre que alcançar o estrelato nos cassinos exige manipulações, rivalidades implacáveis e sacrifícios extremos.",
      { h: 30, x: "60%" }),

    f("my-darling-clementine", "My Darling Clementine", "Faroeste", 1946, 97, "12",
      "Após o roubo de seu gado e o assassinato do irmão mais novo, Wyatt Earp assume o posto de xerife em Tombstone e se vê envolvido na chegada de Clementine Carter e no conflito com os Clanton que culmina no tiroteio do O.K. Corral."),

    f("kiss-me-deadly", "Kiss Me Deadly", "Suspense", 1955, 106, "14",
      "Um detetive particular encontra uma mulher assustada na estrada e é arrastado para uma trama perigosa em torno de uma maleta misteriosa.",
      { h: 210, x: "50%", video: "https://archive.org/download/kiss-me-deadly-1955/Kiss%20Me%20Deadly%20%281955%29.m4v" }),

    f("johnny-guitar", "Johnny Guitar", "Faroeste", 1954, 110, "14",
      "No Arizona, a dona de um saloon enfrenta o linchamento liderado por uma rival implacável após a chegada de seu ex-amante, um pistoleiro que agora prefere tocar violão.",
      { video: "johnny-guitar-web.mp4" }),

    f("pickpocket", "Pickpocket", "Suspense", 1959, 75, "12",
      "Um jovem em Paris se envolve com o furto de carteiras e passa a viver entre a obsessão e o medo de ser descoberto.",
      { h: 150, x: "60%" }),

    f("east-of-eden", "East of Eden", "Drama", 1955, 118, "12",
      "Na Califórnia do início do século XX, um jovem busca a aprovação do pai e disputa o afeto da família.",
      { video: "east-of-eden-web.mp4" }),

    f("cat-people", "Cat People", "Terror", 1942, 73, "12",
      "Em Nova York, uma jovem artista acredita carregar uma maldição ancestral que a transforma em pantera ao sentir ciúmes ou intimidade."),

    f("a-streetcar-named-desire", "A Streetcar Named Desire", "Drama", 1951, 122, "14",
      "Uma mulher chega à casa da irmã em Nova Orleans e a convivência com o cunhado leva a conflitos cada vez mais tensos.",
      { h: 330, x: "45%" }),

    f("ugetsu", "Ugetsu", "Drama", 1953, 96, "12",
      "No Japão devastado por guerras civis, dois homens deixam suas famílias em busca de riqueza e encontram forças sobrenaturais.",
      { h: 175, x: "25%" })
  ];
})();
