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

app.post('/send-track/:kind/:peerId', async (req, res) => {
  try {
    let { peerId, kind } = req.params;
    let { rtpParameters } = req.body;
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
      // appData: { ...appData, peerId }
    });

    // if our associated transport closes, close ourself, too
    producer.on('transportclose', () => {
      console.log('producer\'s transport closed', producer.id);
      //      closeProducer(producer);
    });

    // console.log('producer', producer);

    if (kind === 'video') {
      peers[peerId].videoProducer = producer;      
    } else if (kind === 'audio') {
      peers[peerId].audioProducer = producer;
    }
    await startRecord(peerId, kind);
    //peers[peerId].producers = [];
    //peers[peerId].producers.push(producer);

    res.send({ id: producer.id });

    // await startRecord(peerId);

  } catch (e) {
    console.log(e)
  }
});



const publishProducerRtpStream = async (producer) => {
  console.log('publishProducerRtpStream()');

  // Create the mediasoup RTP Transport used to send media to the GStreamer process
  const rtpTransport = await createRtpTransport();

  // Set the receiver RTP ports
  const remoteRtpPort = await getPort();

  // Connect the mediasoup RTP transport to the ports used by GStreamer
  await rtpTransport.connect({
    ip: '127.0.0.1',
    port: remoteRtpPort,
  });

  const codecs = [];
  // Codec passed to the RTP Consumer must match the codec in the Mediasoup router rtpCapabilities
  const routerCodec = router.rtpCapabilities.codecs.find(
    codec => codec.kind === producer.kind
  );
  codecs.push(routerCodec);

  const rtpCapabilities = {
    codecs,
    rtcpFeedback: []
  };

  // Start the consumer paused
  // Once the gstreamer process is ready to consume resume and send a keyframe
  const rtpConsumer = await rtpTransport.consume({
    producerId: producer.id,
    rtpCapabilities,
    // paused: true
  });

  return {
    remoteRtpPort,
    localRtcpPort: rtpTransport.rtcpTuple ? rtpTransport.rtcpTuple.localPort : undefined,
    rtpCapabilities,
    rtpParameters: rtpConsumer.rtpParameters
  };
};

async function startRecord(peerId, kind) {
  try {
    console.log('start record', kind, peerId);

    let producer;
    if (kind === 'video') {
      producer = peers[peerId].videoProducer;
    } else if (kind === 'audio') {
      producer = peers[peerId].audioProducer;
    }

    console.log(' find producer', kind);

    const d = await publishProducerRtpStream(producer);
    console.log('data', JSON.stringify(d, false, 2));

    let recordInfo = {};
    recordInfo[kind] = d;
    recordInfo.fileName = Date.now().toString();

    try {
      if (kind === 'video') {
        peers[peerId].processVideo = new FFmpeg(recordInfo, peerId, 'video');
      } else if (kind === 'audio') {
        peers[peerId].processAudio = new FFmpeg(recordInfo, peerId, 'audio');
      }
    } catch (e) {
      console.log('error', e);
    }

  } catch (e) {
    console.log('e', e);
  }
}

app.post('/recv-track/:kind/:peerId', async (req, res) => {
  try {
    let { kind, peerId } = req.params;
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
    let producer;
    // console.log('producers', peers[peerId].producers);
    if (kind === 'video') {
      producer = otherPeer.videoProducer;
    } else if (kind === 'audio') {
      producer = otherPeer.audioProducer;
    }     
    console.log('producer', producer.id);

    if (!router.canConsume({ producerId: producer.id, rtpCapabilities })) {
      let msg = `client cannot consume ${kind} ${peerId}`;
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