// functions/index.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { Resend } = require('resend');
const AWS = require('aws-sdk');

admin.initializeApp();

// ============================================
// 更新郵件設置（僅管理員可調用）
// ============================================
exports.updateEmailSettings = functions.https.onCall(async (data, context) => {
  // 驗證管理員權限
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', '請先登入');
  }
  
  const userDoc = await admin.firestore().collection('users').doc(context.auth.uid).get();
  const userData = userDoc.data();
  if (userData.role !== 'admin') {
    throw new functions.https.HttpsError('permission-denied', '只有管理員可以修改郵件設置');
  }
  
  const { enabled, provider, resendApiKey, sesAccessKey, sesSecretKey, sesRegion, fromName, fromEmail } = data;
  
  // 儲存設置到 Firestore（但不儲存 API Key）
  const settings = {
    email: {
      enabled: enabled || false,
      provider: provider || 'resend',
      // 只儲存是否已配置，不儲存實際 Key
      configured: {
        resend: !!resendApiKey,
        ses: !!(sesAccessKey && sesSecretKey)
      },
      fromName: fromName || '英語默書系統',
      fromEmail: fromEmail || '',
      updatedAt: new Date().toISOString(),
      updatedBy: context.auth.uid
    }
  };
  
  await admin.firestore().collection('settings').doc('notifications').set(settings, { merge: true });
  
  // 如果有提供 API Key，儲存到 secrets 集合（僅 Cloud Function 可讀取）
  if (provider === 'resend' && resendApiKey) {
    await admin.firestore().collection('secrets').doc('email').set({
      resendApiKey: resendApiKey,
      updatedAt: new Date().toISOString(),
      updatedBy: context.auth.uid
    }, { merge: true });
  } else if (provider === 'ses' && sesAccessKey && sesSecretKey) {
    await admin.firestore().collection('secrets').doc('email').set({
      ses: {
        accessKeyId: sesAccessKey,
        secretAccessKey: sesSecretKey,
        region: sesRegion || 'us-east-1'
      },
      updatedAt: new Date().toISOString(),
      updatedBy: context.auth.uid
    }, { merge: true });
  }
  
  return { success: true };
});

// ============================================
// 獲取郵件設置（僅管理員可調用）
// ============================================
exports.getEmailSettings = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', '請先登入');
  }
  
  const userDoc = await admin.firestore().collection('users').doc(context.auth.uid).get();
  const userData = userDoc.data();
  if (userData.role !== 'admin') {
    throw new functions.https.HttpsError('permission-denied', '只有管理員可以查看郵件設置');
  }
  
  // 從 Firestore 獲取公開設置
  const settingsDoc = await admin.firestore().collection('settings').doc('notifications').get();
  const settings = settingsDoc.data() || {};
  
  // 檢查是否已配置
  const secretsDoc = await admin.firestore().collection('secrets').doc('email').get();
  const secrets = secretsDoc.data() || {};
  
  return {
    email: {
      enabled: settings.email?.enabled || false,
      provider: settings.email?.provider || 'resend',
      configured: {
        resend: !!secrets.resendApiKey,
        ses: !!(secrets.ses?.accessKeyId)
      },
      fromName: settings.email?.fromName || '英語默書系統',
      fromEmail: settings.email?.fromEmail || ''
    }
  };
});

// ============================================
// 發送郵件 Cloud Function
// ============================================
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
  
  // 從 secrets 集合獲取 API Key
  const secretsDoc = await admin.firestore().collection('secrets').doc('email').get();
  const secrets = secretsDoc.data();
  
  const provider = settings.email.provider;
  const from = `${settings.email.fromName} <${settings.email.fromEmail}>`;
  
  try {
    if (provider === 'resend') {
      if (!secrets?.resendApiKey) {
        throw new Error('Resend API Key 未設定');
      }
      const resend = new Resend(secrets.resendApiKey);
      await resend.emails.send({ from, to, subject, html });
    } else if (provider === 'ses') {
      if (!secrets?.ses) {
        throw new Error('SES 憑證未設定');
      }
      AWS.config.update({
        accessKeyId: secrets.ses.accessKeyId,
        secretAccessKey: secrets.ses.secretAccessKey,
        region: secrets.ses.region || 'us-east-1'
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

// ============================================
// 測試郵件發送
// ============================================
exports.testEmail = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', '請先登入');
  }
  
  const userDoc = await admin.firestore().collection('users').doc(context.auth.uid).get();
  const userData = userDoc.data();
  if (userData.role !== 'admin') {
    throw new functions.https.HttpsError('permission-denied', '只有管理員可以發送測試郵件');
  }
  
  const { to } = data;
  
  return await exports.sendEmail({
    to,
    subject: '英語默書系統測試郵件',
    html: '<h2>測試郵件</h2><p>如果您收到此郵件，表示郵件通知功能正常運作。</p>'
  }, context);
});

// ============================================
// 發送通知時觸發郵件
// ============================================
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
    
    // 發送郵件給每個用戶
    const promises = userEmails.map(email => {
      return exports.sendEmail({
        to: email,
        subject: notification.title,
        html: `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>${notification.title}</h2>
          <p style="font-size: 16px; line-height: 1.5;">${notification.content}</p>
          <hr style="margin: 20px 0;">
          <p style="color: #6b7280; font-size: 12px;">此郵件由英語默書系統自動發送，請勿直接回覆。</p>
        </div>`
      }, { auth: { uid: 'system' } }).catch(err => console.error('發送郵件失敗:', email, err));
    });
    
    await Promise.all(promises);
    return null;
  });