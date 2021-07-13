const config = require('config');
const mediasoup = require('mediasoup');
const express = require('express');
const cors = require('cors');
const _ = require('lodash');

const FFmpeg = require('./record/ffmpeg');
const {
  getPort,
  releasePort
} = require('./record/port');

const app = express();
app.use(cors());
app.use(express.json());

let peers = {};
let worker, router;

async function startMediasoup() {
  let worker = await mediasoup.createWorker({
    logLevel: config.mediasoup.worker.logLevel,
    logTags: config.mediasoup.worker.logTags,
    rtcMinPort: config.mediasoup.worker.rtcMinPort,
    rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
  });

  worker.on('died', () => {
    console.log('mediasoup worker died (this should never happen)');
    process.exit(1);
  });

  const mediaCodecs = config.mediasoup.router.mediaCodecs;
  const router = await worker.createRouter({ mediaCodecs });

  return { worker, router };
}


async function start () {
  let mediasoup = await startMediasoup();
  worker = mediasoup.worker;
  router = mediasoup.router;
};

(start)();

app.post('/rtpCapabilities', async (req, res) => {
  console.log('ttt');  
  res.json({ routerRtpCapabilities: router.rtpCapabilities });
})


app.post('/create-transport/:direction/:peerId', async (req, res) => {
  try {
    let { peerId, direction } = req.params;
    console.log('create-transport', peerId, direction);

    let transport = await createWebRtcTransport();

    if(!peers[peerId]) {
      peers[peerId] = {}
    }

    if (direction === 'send') {
      peers[peerId].sendTransport = transport;
    } else if (direction === 'recv') {
      peers[peerId].recvTransport = transport;
    }

    let { id, iceParameters, iceCandidates, dtlsParameters } = transport;
    res.send({
      transportOptions: { id, iceParameters, iceCandidates, dtlsParameters }
    });
  } catch (e) {
    console.error('error in /create-transport', e);
    res.send({ error: e });
  }
});

async function createWebRtcTransport() {
  const {
    listenIps,
    initialAvailableOutgoingBitrate
  } = config.mediasoup.webRtcTransport;

  const transport = await router.createWebRtcTransport({
    listenIps: listenIps,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: initialAvailableOutgoingBitrate,
//    appData: { peerId, clientDirection: direction }
  });

  return transport;
}

async function createRtpTransport() {
  const rtpTransportSettings = config.mediasoup.rtpTransport;
  const transport = await router.createPlainTransport(rtpTransportSettings);
  return transport;
}


app.post('/connect-transport/:direction/:peerId', async (req, res) => {
  try {
    let { direction, peerId } = req.params;
    let { dtlsParameters } = req.body;
    let transport = direction === 'send' ? peers[peerId].sendTransport : peers[peerId].recvTransport;

    if (!transport) {
      console.err(`connect-transport: server-side transport ${peerId} not found`);
      res.send({ error: `server-side transport ${peerId} not found` });
      return;
    }

    console.log('connect-transport', peerId);

    await transport.connect({ dtlsParameters });
    res.send({ connected: true });
  } catch (e) {
    console.error('error in /signaling/connect-transport', e);
    res.send({ error: e });
  }
});

app.post('/send-track', async (req, res) => {
  try {
    let { peerId, kind, rtpParameters, appData } = req.body;
    let transport = peers[peerId].sendTransport;
    
    console.log('transport'); //, transport);

    if (!transport) {
      err(`send-track: server-side transport ${peerId} not found`);
      res.send({ error: `server-side transport ${peerId} not found`});
      return;
    }

    let producer = await transport.produce({
      kind,
      rtpParameters,
      // paused: true,
      appData: { ...appData, peerId }
    });

    // if our associated transport closes, close ourself, too
    producer.on('transportclose', () => {
      console.log('producer\'s transport closed', producer.id);
      //      closeProducer(producer);
    });

    // console.log('producer', producer);

    peers[peerId].producers = [];
    peers[peerId].producers.push(producer);

    res.send({ id: producer.id });

    await startRecord(peerId);

  } catch (e) {
    console.log(e)
  }
});

async function startRecord(peerId) {
  try {
    console.log('start record', peerId);
    peers[peerId].rtpTransport = await createRtpTransport();

    // console.log(peers[peerId]);

    const rtpPort = await getPort();
    console.log('rtp port', rtpPort);
    await peers[peerId].rtpTransport.connect({
      ip: '0.0.0.0',
      port: rtpPort,
      // rtcpPort: 200001,
    });

    let producer = peers[peerId].producers[0];

    const codecs = [];
    // Codec passed to the RTP Consumer must match the codec in the Mediasoup router rtpCapabilities
    const routerCodec = router.rtpCapabilities.codecs.find(
      codec => codec.kind === producer.kind
    );
    codecs.push(routerCodec);

    console.log('codecs', codecs);

    const rtpCapabilities = {
      codecs,
      rtcpFeedback: []
    };

    // Start the consumer paused
    // Once the gstreamer process is ready to consume resume and send a keyframe
    const rtpConsumer = await peers[peerId].rtpTransport.consume({
      producerId: producer.id,
      rtpCapabilities,
      //paused: true
    });


    const d = {
      remoteRtpPort: rtpPort,
      // remoteRtcpPort: 20001,
      localRtcpPort: peers[peerId].rtpTransport.rtcpTuple ? peers[peerId].rtpTransport.rtcpTuple.localPort : undefined,
      rtpCapabilities,
      rtpParameters: rtpConsumer.rtpParameters
    };
    console.log('data', JSON.stringify(d, false, 2));

    let recordInfo = {};
    recordInfo['video'] = d;
    recordInfo.fileName = Date.now().toString();
    peers[peerId].process = new FFmpeg(recordInfo);

  } catch (e) {
    console.log('e', e);
  }
}

app.post('/recv-track/:peerId', async (req, res) => {
  try {
    let { peerId } = req.params;
    let { mediaPeerId, mediaTag, rtpCapabilities } = req.body;

    let peerIds = _.without(Object.keys(peers), peerId);
    console.log('peerIds', peerIds, peerId);

    let otherPeerId = peerIds[0];
    if (!otherPeerId) {
      console.log('no other peer id');
      res.send({status: 'not ready'});
      return
    }

    console.log('otherPeerId', peerIds, otherPeerId);
    let otherPeer = peers[otherPeerId];
    let peer = peers[peerId];

    // console.log('producers', peers[peerId].producers);
    let producer = otherPeer.producers[0];
    console.log('producer', producer.id);

    if (!router.canConsume({ producerId: producer.id, rtpCapabilities })) {
      let msg = `client cannot consume ${peerId}`;
      console.log(`recv-track: ${peerId} ${msg}`);
      res.send({ error: msg });
      return;
    }

    let consumer = await peer.recvTransport.consume({
      producerId: producer.id,
      rtpCapabilities,
      // paused: true,
    });

    res.send({
      producerId: producer.id,
      id: consumer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      type: consumer.type,
      producerPaused: consumer.producerPaused
    });

  } catch (e) {
    console.error('error in /signaling/recv-track', e);
    res.send ({ error: e });
  }

});

app.listen(3000);