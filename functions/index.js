// functions/index.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { Resend } = require('resend');
const AWS = require('aws-sdk');

admin.initializeApp();

// 發送郵件 Cloud Function
exports.sendEmail = functions.https.onCall(async (data, context) => {
  // 驗證管理員權限
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', '請先登入');
  }
  
  const userDoc = await admin.firestore().collection('users').doc(context.auth.uid).get();
  const userData = userDoc.data();
  if (userData.role !== 'admin') {
    throw new functions.https.HttpsError('permission-denied', '只有管理員可以發送郵件');
  }
  
  const { to, subject, html } = data;
  
  // 獲取郵件設置
  const settingsDoc = await admin.firestore().collection('settings').doc('notifications').get();
  const settings = settingsDoc.data();
  
  if (!settings?.email?.enabled) {
    throw new functions.https.HttpsError('failed-precondition', '郵件通知未啟用');
  }
  
  const provider = settings.email.provider;
  const credentials = settings.email.credentials[provider];
  const from = `${settings.email.fromName} <${settings.email.fromEmail}>`;
  
  try {
    if (provider === 'resend') {
      const resend = new Resend(credentials.apiKey);
      await resend.emails.send({ from, to, subject, html });
    } else if (provider === 'ses') {
      AWS.config.update({
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        region: credentials.region
      });
      const ses = new AWS.SES({ apiVersion: '2010-12-01' });
      await ses.sendEmail({
        Source: from,
        Destination: { ToAddresses: [to] },
        Message: {
          Subject: { Data: subject },
          Body: { Html: { Data: html } }
        }
      }).promise();
    }
    
    return { success: true };
  } catch (error) {
    console.error('發送郵件失敗:', error);
    throw new functions.https.HttpsError('internal', '發送郵件失敗：' + error.message);
  }
});

// 發送通知時觸發郵件（針對管理員發送的重要通知）
exports.onNotificationCreated = functions.firestore
  .document('notifications/{notificationId}')
  .onCreate(async (snap, context) => {
    const notification = snap.data();
    
    // 只有標記 sendEmail 的通知才發送郵件
    if (!notification.sendEmail) return null;
    
    // 獲取目標用戶郵箱
    let userIds = [];
    const target = notification.targetUsers;
    
    if (!target || (Array.isArray(target) && target.length === 0)) {
      // 全部用戶
      const users = await admin.firestore().collection('users').get();
      userIds = users.docs.map(doc => doc.id);
    } else if (target.type === 'branch') {
      const users = await admin.firestore().collection('users')
        .where('branch', '==', target.value)
        .get();
      userIds = users.docs.map(doc => doc.id);
    } else if (target.type === 'selected') {
      userIds = target.value;
    }
    
    // 獲取用戶郵箱
    const userEmails = [];
    for (const userId of userIds) {
      const userDoc = await admin.firestore().collection('users').doc(userId).get();
      if (userDoc.exists && userDoc.data().email) {
        userEmails.push(userDoc.data().email);
      }
    }
    
    if (userEmails.length === 0) return null;
    
    // 調用郵件發送函數（需要部署可調用函數）
    const sendEmailFunc = functions.httpsCallable('sendEmail');
    const promises = userEmails.map(email => {
      return sendEmailFunc({
        to: email,
        subject: notification.title,
        html: `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>${notification.title}</h2>
          <p style="font-size: 16px; line-height: 1.5;">${notification.content}</p>
          <hr style="margin: 20px 0;">
          <p style="color: #6b7280; font-size: 12px;">此郵件由英語默書系統自動發送，請勿直接回覆。</p>
        </div>`
      }).catch(err => console.error('發送郵件失敗:', email, err));
    });
    
    await Promise.all(promises);
    return null;
  });