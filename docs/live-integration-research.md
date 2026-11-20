# بحث الربط الحقيقي لمنصة Atheer

## النتيجة العملية

يوجد مصدر سوق حقيقي يمكن التفاوض عليه، وهو ICE Data Services لبيانات البورصة المصرية EGX. توضح صفحة EGX الرسمية لدى ICE أن التغطية تشمل الأسهم والصناديق المتداولة والسندات والمؤشرات، مع بيانات Level 1 وLevel 2 وبيانات لحظية ومتأخرة ونهاية اليوم وتاريخية، وطرق تسليم تشمل ICE Data API وICE Consolidated Feed وملفات البيانات. الصفحة لا تنشر سعرًا عامًا أو مفتاحًا جاهزًا؛ يلزم عقد يحدد التغطية وحقوق إعادة النشر وعدد العملاء ونوع البيانات. [1]

للتنفيذ، لا توجد في المصادر العامة التي تم فحصها واجهة API تجزئة مصرية مفتوحة يمكن تركيبها بأمان دون عقد. شركة Thndr تعرض تداول الأسهم المصرية والذهب والصناديق، وتذكر صراحة أن التداول يتم عبر Thndr Securities Brokerage المرخصة والمنظمة من FRA. هذا يثبت وجود جهة وساطة مرخصة، لكنه لا يثبت أن لديها API أو FIX متاحًا لتطبيق خارجي باسم Atheer. يجب طلب Embedded Brokerage أو Institutional API وبيئة Sandbox كتابةً. [2]

Beltone Securities Brokerage خيار مؤسسي آخر للتواصل. موقعها الرسمي يذكر خدمات التداول للأفراد والمؤسسات والتداول الإلكتروني وتطبيق الهاتف، لكنه لا ينشر مواصفات API أو FIX أو Sandbox أو أسعار تكامل عامة. لذلك هي مرشح للتفاوض، وليست تكاملًا جاهزًا. [3]

## الجهات المقترحة للتواصل

### 1. بيانات السوق: ICE Data Services

- صفحة تغطية EGX: https://developer.ice.com/fixed-income-data-services/catalog/egyptian-exchange-egx
- طلب التواصل: https://www.ice.com/catalog/fixed-income-data-services/contact-us?venue=EGX
- المطلوب في الطلب: EGX equities/ETFs، Level 1، تاريخي، تحديثات لحظية، حقوق إعادة النشر داخل تطبيق جوال، وعدد المستخدمين المتوقع.
- السعر: غير منشور علنًا في صفحة EGX، ويحتاج عرضًا تجاريًا.

يجب أيضًا استخدام قائمة أعضاء EGX الرسمية للتحقق من أي وسيط قبل التعاقد، ثم التحقق من الترخيص ونطاق النشاط من FRA. قائمة EGX التي تم فحصها تعرض شركات وساطة أعضاء وتوضح أن الاختيار النهائي يجب أن يكون من القائمة الرسمية. [4]

### 2. الوسيط: Thndr أو Beltone

اطلب من كل جهة خطابًا يجيب عن الأسئلة التالية:

1. هل يمكن لـ Atheer العمل كواجهة تقنية مرتبطة بحساب عميل لدى الوسيط دون أن تصبح Atheer وسيطًا أو أمين حفظ؟
2. هل توجد API أو FIX لإرسال الأوامر والاستعلام عن الأرصدة والتنفيذات والإلغاء؟
3. هل توجد Sandbox منفصلة؟
4. هل يوجد webhook أو drop-copy للتنفيذات؟
5. كيف يتم KYC/AML وفتح حساب الوساطة لكل عميل؟
6. أين تُحفظ أموال وأوراق العميل؟
7. ما حدود المعدل، وسياسة idempotency، والرسوم، ودعم الرموز المصرية؟
8. هل يسمح العقد بإعادة عرض الأسعار داخل Atheer؟

لا يمكنني اختراع endpoint أو مفتاح API للوسيط. بعد استلام مواصفات رسمية ومفاتيح Sandbox، أستطيع تنفيذ adapter خاص بالوسيط، ثم اختباره على أوامر وهمية داخل Sandbox قبل أي تفعيل إنتاجي.

### 3. الدفع والتحصيل: Paymob أو Fawry Accept

Paymob تنشر رسميًا أنها تدعم البطاقات والمحافظ، ومنها Vodafone Cash، وتوفر Hosted Checkout وMobile SDKs وPayouts. صفحة الأسعار المنشورة تعرض للخطة القياسية 2.75% + 3 جنيه لكل معاملة، مع تسوية أسبوعية وبدون رسوم شهرية أو اشتراك؛ التسعير المؤسسي يحتاج تواصلًا، كما يجب موافقة Paymob على نموذج Atheer لأن استقبال أموال الاستثمار ليس مثل متجر إلكتروني عادي. [5]

Fawry Accept تنشر دعم البطاقات وFawry Pay والمحافظ وروابط الدفع، إضافة إلى لوحات التقارير والمطابقة وواجهات التكامل. كما تذكر صفحة الخدمة متطلبات أمنية وترخيصًا محليًا، لكن السعر غير منشور ويجب بدء التواصل من نموذج الشركات. يجب التأكد كتابيًا من قبول نموذج الأموال والاستثمار قبل بناء تدفق الإيداع والسحب عليه. [6]

- Paymob Developers: https://developers.paymob.com/
- Paymob Pricing: https://www.paymob.com/en/pricing
- Fawry Accept: https://www.fawry.com/business/acceptance/online-checkout/
- Fawry Developer Guide: https://developer.fawrystaging.com/

## ما تم في كود Atheer

يوجد في المشروع فصل واضح بين `MarketDataProvider` و`BrokerAdapter` و`PaymentProvider`. الوضع الافتراضي الآن `not_configured`: لا تُعرض أسعار محاكاة، ولا تُرسل أوامر، ولا يُعتمد دفع خارجي. هذا متعمد حتى لا يظهر سعر أو تنفيذ غير حقيقي.

عند وصول مواصفات المزود، ستكون الخطوات البرمجية هي إضافة adapter للمصدر، حفظ المفاتيح في Secrets، إضافة webhook موقّع للتنفيذات، حفظ `brokerOrderId` و`executionId`، تطبيق idempotency، ثم تحديث المراكز والسجل النقدي بعد تأكيد التنفيذ فقط. لن يتم تفعيل `LIVE_TRADING_ENABLED` قبل نجاح اختبارات Sandbox والمطابقة.

## المتطلبات القانونية والتشغيلية

FRA توفر صفحات رسمية للترخيص والمؤسسات المرخصة، ويجب التحقق منها قبل استقبال أوامر أو أموال العملاء. كما يوضح CBE Regulatory Sandbox أنه مخصص لمزودي FinTech المسجلين تجاريًا والمؤسسات المالية المرخصة، وأن الاختبار يكون وفق سيناريو ومعايير متفق عليها؛ المدة العامة ستة أشهر وقد تمتد إلى اثني عشر شهرًا، والخدمة نفسها بلا رسوم لكن موارد الاختبار على مقدم الطلب. [7]

الخلاصة: أستطيع تنفيذ الربط البرمجي بعد اختيار وسيط ومصدر بيانات وتزويدي بعقد أو مواصفات Sandbox والمفاتيح عبر قناة الأسرار. لا توجد حاليًا واجهة عامة موثقة تسمح لي بتفعيل تداول EGX حقيقي من داخل المشروع دون هذه المتطلبات، ولن أضع مفاتيحًا مخترعة أو أفعّل التداول بأموال حقيقية قبلها.

## References

[1]: https://developer.ice.com/fixed-income-data-services/catalog/egyptian-exchange-egx "ICE Data Services — Egyptian Exchange EGX"
[2]: https://thndr.app/ "Thndr — Egyptian stocks, gold and funds"
[3]: https://www.beltoneholding.com/business-line/securities-brokerage "Beltone Securities Brokerage"
[4]: https://www.egx.com.eg/en/memberfirmslist.aspx "Egyptian Exchange — Member Firms List"
[5]: https://www.paymob.com/en/pricing "Paymob Pricing"
[6]: https://www.fawry.com/business/acceptance/online-checkout/ "Fawry Accept Online Checkout"
[7]: https://www.cbe.org.eg/en/financial-technology/regulatory-sandbox "Central Bank of Egypt Regulatory Sandbox"
