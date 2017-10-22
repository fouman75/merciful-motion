// server.js
// where your node app starts

// init project
var express = require('express');
var app = express();
var passport = require('passport');
var cors = require('cors');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const session = require('express-session');
const FacebookStrategy = require('passport-facebook').Strategy;
const MeetupOAuth2Strategy = require('passport-oauth2-meetup').Strategy;
var admin = require("firebase-admin");
var loki = require('lokijs');
var axios = require('axios');

// we've started you off with Express, 
// but feel free to use whatever libs or frameworks you'd like through `package.json`.

var serviceAccount = require("./.data/fou.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.fb_databaseURL
});

const db = new loki('./.data/loki.json');
const users = db.addCollection('users');


app.use(cors());

// http://expressjs.com/en/starter/static-files.html
app.use(express.static('public'));
// set up our express application
app.use(morgan('tiny')); // log every request to the console
// app.use(cookieParser); // read cookies (needed for auth)
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// required for passport
const sessionParams = { 
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false
};

app.use(session(sessionParams)); // session secret
app.use(passport.initialize());
app.use(passport.session()); // persistent login sessions

// http://expressjs.com/en/starter/basic-routing.html
app.get("/", function (request, response) {
  const jsonReq = JSON.stringify(request.user);
  const jsonRes = JSON.stringify(response.user);
  console.log(`===REQUEST: ${jsonReq}`);
  console.log(`===RESPONSE: ${jsonRes}`);
  response.sendFile(__dirname + '/views/index.html');
});

app.post('/fb-token',function(req,res) {
  var mu_token=req.body.mu_token;
  let URL = 'https://api.meetup.com/members/self?fields=memberships';

  const AuthStr = 'Bearer '.concat(mu_token);
  console.log(`=== auth: ${AuthStr}`);
  axios.get(URL, { headers: { Authorization: AuthStr } })
  .then(response => {
    //console.log(response);
    const profile = response.data;
    //console.log(`=== profile: ${JSON.stringify(profile)}`);
    if (profile.memberships && profile.memberships.organizer) {
      const isOrganizer = profile.memberships.organizer.filter( (org) => {
        return (org.status === 'active' && org.group.id == process.env.meetup_group_id);
      });
      
      if (isOrganizer.length === 0) {
        throw 'invalid permissions';
      }
    
      let data = {profile: profile};
      //console.log(response.data.results[0]);
      const uid = data.profile.id + ''; // convert to string
      //console.log(`=== uid: ${uid}`);
      var additionalClaims = {
        organiser: true,
        host: true
      };
      admin.auth().createCustomToken(uid, additionalClaims)
        .then(function(customToken) {
          //console.log(`FB TOKEN: ${customToken}`);
          data.fb_token = customToken;
          res.send(data);
      });
    } else {
      throw 'invalid permissions';
    }
  })
  .catch((error) => {
    let data = {error: true};
    console.log(error);
    res.send(data);
  });
});

app.get('/fetchPastMeetups', function(req,res) {
  //console.log(JSON.stringify(req.headers));
  const mu_token=req.headers.authorization;
  //console.log(`===token: ${mu_token}`)
  let URL = 'https://api.meetup.com/badminton-montreal/events?desc=true&scroll=recent_past&photo-host=public&page=20&status=past&fields=event_hosts';

  axios.get(URL, { headers: { Authorization: mu_token } })
  .then(response => {
    const meetups = response.data;
    res.send(meetups);
  })
  .catch((error) => {
    const data = {error: true};
    console.log(error);
    res.status(500);
    res.send(data);
  });
});

app.get('/fetchRsvps', function(req,res) {
  const mu_token=req.headers.authorization;
  const meetupId=req.query.meetupId;
  console.log(`===meetupId: ${meetupId}`);
  let URL = `https://api.meetup.com/badminton-montreal/events/${meetupId}/rsvps?&photo-host=public&order=social`;

  axios.get(URL, { headers: { Authorization: mu_token } })
  .then(response => {
    const rsvps = response.data;
    rsvps.sort((a,b) => {
      return (a.updated < b.updated ? -1 : 1);
    }).reverse();
    res.send(rsvps);
  })
  .catch((error) => {
    const data = {error: true};
    console.log(error);
    res.status(500);
    res.send(data);
  });
});

// Facebook auth
passport.use(
  new FacebookStrategy({
    // pull in our app id and secret from our auth.js file
    clientID        : process.env.facebookAuth_clientID,
    clientSecret    : process.env.facebookAuth_clientSecret,
    callbackURL     : process.env.facebookAuth_callbackURL
  },
  // facebook will send back the token and profile
  function(token, refreshToken, profile, done) {
    console.log("====== Profile function");
    console.log(token);
    console.log(`Profile: ${profile.id} - ${profile.displayName}`);
    done(null, profile);
  })
);

passport.use(new MeetupOAuth2Strategy({
  clientID: process.env.meetup_clientID,
  clientSecret: process.env.meetup_clientSecret,
  callbackURL: process.env.meetup_callbackURL,
  autoGenerateUsername: true,
}, function(accessToken, refreshToken, profile, done) {
    // console.log("===Profile: ");
    // console.log(profile);
    try {
      var user = {
        id: profile.id,
        name: profile.displayName,
        picture: profile._json.photo.highres_link,
        mu_token: accessToken,
        mu_refresh: refreshToken
      };
      
      const uid = profile.id + ''; // convert to string
      var additionalClaims = {
        organiser: true,  // TODO: read status from badminton group
        host: true
      };
      admin.auth().createCustomToken(uid, additionalClaims)
        .then(function(customToken) {
          console.log(`FB TOKEN: ${customToken}`);
          user.fb_token = customToken;
          user = users.insert(user);
          console.log(user);
      
          return done(null, user);
      });
    } catch(e) {
      console.log(e);
      return done(null, {err: 'internal error'});  // fake user so we can go to callback and redirect from there
    }
}));

app.get('/auth/facebook', 
  passport.authenticate('facebook', { scope : ['email', 'user_birthday'] })
);

// handle the callback after facebook has authenticated the user
app.get('/auth/facebook/callback',
	passport.authenticate('facebook', {
    session: false
	}),
  function(req, res) {
    console.log("Facebook callback")
    // const reqHeaders = JSON.stringify(req.headers);
    // const resHeaders = JSON.stringify(res.headers);
    // console.log(`====HEADERS: ${reqHeaders}`);
    // console.log(`====HEADERS: ${resHeaders}`);
    //res.json({ id: req.user.id, username: req.user.displayName });
    res.header('Authorization', req.user.id,);
    res.redirect('http://localhost:3000/');
  }
);

app.get('/auth/meetup',
  passport.authenticate('meetup', { session: false})
);

app.get('/auth/meetup/callback', passport.authenticate('meetup', { session: false }),
  function(req, res) {
    if (req.user.err) {
      res.redirect(`http://localhost:3000/login?loginError=${req.user.err}`);
    } else {
      console.log('===Meetup callback ===');
      res.json(req.user);
    }
  }
);

// listen for requests :)
var listener = app.listen(process.env.PORT, function () {
  console.log('Your app is listening on port ' + listener.address().port);
});
